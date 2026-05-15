package text

import (
	"encoding/json"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/realtime"
	"tinycld.org/packages/text/translate"
)

// roomKindText is the realtime roomKind name owned by this package.
// Each connection at /api/realtime/text-doc/<drive_item_id> is gated
// by the authorize handler registered below.
const roomKindText = "text-doc"

// Register wires the text package's server-side hooks. Core's
// generator injects a call to this function from
// `server/package_extensions.go` once the package is linked.
//
// Wiring (mirrors calc's registerRealtime, plus the OnConnect hook
// new in M1 + M2):
//
//   - Authorize: enforces drive_shares membership before the WS
//     upgrade — same predicate as calc.
//   - RuntimeProvider: hands out per-room server-side Y.Doc handles
//     mounted on the package's Runtime; bootstrap reads the docx and
//     seeds the doc before the broker's first SyncReply.
//   - OnRoomCreate / OnDocUpdate / OnEmpty: the SaveCoordinator
//     consumes broker events to drive debounce/ceiling/teardown
//     persistence (Y.Doc -> docx -> drive_items.file).
//   - OnConnect: builds the per-client MsgServerHello payload
//     ({readOnly, importWarnings}) so the joining client can render
//     parse warnings as a banner and (eventually) gate writes.
func Register(app *pocketbase.PocketBase) {
	runtime := NewRuntime()
	runtime.SetBootstrap(makeDocxBootstrap(app, runtime))

	flush := makeProductionFlush(app, runtime)
	saveCoordinator := realtime.NewSaveCoordinator(flush)

	realtime.RegisterRoomKindWith(roomKindText, realtime.RoomKindOptions{
		Authorize:       makeAuthorize(app),
		RuntimeProvider: runtime,
		OnRoomCreate:    saveCoordinator.OnRoomCreate,
		OnDocUpdate:     saveCoordinator.OnDocUpdate,
		OnEmpty:         saveCoordinator.OnRoomEmpty,
		OnConnect:       makeOnConnect(app, runtime),
	})
}

// serverHelloPayload is the JSON body of the MsgServerHello frame
// the broker sends to each freshly-joined client. The shape is
// stable wire contract: the M5 client decodes it via the symmetric
// TS type in @tinycld/text/lib/realtime.
//
//   - ReadOnly toggles the editor between read-only and editable mode.
//     Currently always false (see isReadOnlyForConn for why); the
//     plumbing exists so a future drive-write predicate is a one-line
//     change.
//   - ImportWarnings is non-nil only for the connection that triggered
//     the bootstrap; later joiners on the same room see []. Each
//     warning is a {code, detail} pair the client renders as a
//     dismissable banner.
type serverHelloPayload struct {
	ReadOnly       bool                `json:"readOnly"`
	ImportWarnings []importWarningJSON `json:"importWarnings"`
}

// importWarningJSON mirrors translate.Warning but pins the wire shape
// so the client decoder doesn't have to know about the full Go type
// (Warning.Context is omitted from the wire intentionally — v1 has no
// consumer for it and shipping nil/empty maps confuses the JS side).
type importWarningJSON struct {
	Code   string `json:"code"`
	Detail string `json:"detail,omitempty"`
}

// makeOnConnect returns a ServerHelloFn that builds the per-client
// MsgServerHello payload: { readOnly, importWarnings }.
//
// Pops importWarnings from the runtime so only the first joiner of a
// freshly-bootstrapped room sees them — that's by design; the
// warnings describe an import event that happened once at room start,
// and a later reload should see a clean slate.
func makeOnConnect(app core.App, runtime *Runtime) realtime.ServerHelloFn {
	return func(roomID string, conn *realtime.Client) ([]byte, error) {
		readOnly := isReadOnlyForConn(app, roomID, conn)
		warnings := runtime.PopImportWarnings(roomID)
		payload := serverHelloPayload{
			ReadOnly:       readOnly,
			ImportWarnings: convertWarnings(warnings),
		}
		return json.Marshal(payload)
	}
}

// convertWarnings maps the internal translate.Warning slice to the
// wire shape. Always returns a non-nil slice (possibly empty) so the
// JSON marshals as `[]` instead of `null` — keeps client decode
// branchless.
func convertWarnings(in []translate.Warning) []importWarningJSON {
	out := make([]importWarningJSON, len(in))
	for i, w := range in {
		out[i] = importWarningJSON{Code: string(w.Code), Detail: w.Detail}
	}
	return out
}

// isReadOnlyForConn determines whether the connecting user has edit
// rights on the underlying drive_item.
//
// v1 STUB: always returns false.
//
// Drive's permission model doesn't yet expose a clean "may write"
// predicate (drive_shares carries roles but the role taxonomy is
// still in flux); viewer-role users can edit through the realtime
// broker today. The MsgServerHello plumbing is in place so that
// when drive surfaces a write predicate, this function becomes a
// one-line change to query that predicate and return its negation.
//
// Note: ServerHelloFn currently has signature (roomID, conn) — the
// authenticated user record isn't threaded through. When drive's
// write predicate lands, the realtime layer will likely grow an
// `auth *core.Record` parameter on this hook; until then there's
// no point doing partial enforcement here.
func isReadOnlyForConn(_ core.App, _ string, _ *realtime.Client) bool {
	return false
}
