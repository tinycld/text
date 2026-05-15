package text

import (
	"fmt"
	"log/slog"
	"sync"

	ycrdt "github.com/skyterra/y-crdt"

	"tinycld.org/core/realtime"
	"tinycld.org/packages/text/translate"
)

// Runtime is the text package's server-side Y.Doc registry. One per
// process; the broker calls NewDoc once per active room and the
// returned handle owns the room's mirror until Close.
//
// Backed by github.com/skyterra/y-crdt (a native-Go yjs decoder /
// encoder). Operations on a single Y.Doc serialize through that doc's
// own internal state machine; the per-room mutex below only guards the
// docs map itself.
type Runtime struct {
	// bootstrap, when non-nil, runs synchronously inside NewDoc with
	// the freshly-minted Y.Doc. Production wires this to load the
	// drive_items docx and seed it into the doc, so the broker's
	// first SyncReply already carries populated content. Tests leave
	// it nil — they construct doc state via ApplyUpdate.
	bootstrap func(roomID string, doc *ycrdt.Doc) error

	mu   sync.Mutex
	docs map[string]*ycrdt.Doc

	// importWarnings holds per-room warnings produced during bootstrap
	// (e.g. tracked changes stripped, comments dropped). The OnConnect
	// ServerHelloFn pops the entry for a freshly-bootstrapping
	// connection's roomID and includes the warnings in MsgServerHello.
	importWarningsMu sync.Mutex
	importWarnings   map[string][]translate.Warning
}

// NewRuntime returns an empty Runtime. Cheap; no doc state is allocated
// until NewDoc is called.
func NewRuntime() *Runtime {
	return &Runtime{
		docs:           map[string]*ycrdt.Doc{},
		importWarnings: map[string][]translate.Warning{},
	}
}

// SetBootstrap registers a per-room bootstrap hook. NewDoc invokes the
// hook (if set) inside the same critical section that creates the doc,
// so MsgSyncRequest replies are guaranteed to see the populated state.
//
// A nil hook disables bootstrap (for tests). Passing nil after a hook
// has been registered clears it.
func (r *Runtime) SetBootstrap(hook func(roomID string, doc *ycrdt.Doc) error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.bootstrap = hook
}

// NewDoc satisfies realtime.DocRuntime: mints a fresh server-side
// Y.Doc identified by the broker's roomID and returns an opaque
// handle the broker calls into for the room's lifetime.
//
// If a bootstrap hook is registered, it runs synchronously after the
// doc is created. Bootstrap failures are logged but do not abort the
// room creation — a partially-bootstrapped (or empty) doc is preferable
// to refusing the connection, since a peer-driven SyncRequest path
// can still recover.
func (r *Runtime) NewDoc(roomID string) (realtime.DocHandle, error) {
	r.mu.Lock()
	if _, exists := r.docs[roomID]; exists {
		r.mu.Unlock()
		return nil, fmt.Errorf("text: room %s already has a Y.Doc", roomID)
	}
	doc := ycrdt.NewDoc(roomID, false, nil, nil, false)
	r.docs[roomID] = doc
	hook := r.bootstrap
	r.mu.Unlock()

	if hook != nil {
		if err := hook(roomID, doc); err != nil {
			slog.Warn("text: bootstrap hook failed; room continues with empty doc",
				"roomID", roomID, "err", err)
		}
	}
	return &textDocHandle{runtime: r, id: roomID, doc: doc}, nil
}

// closeDoc removes the doc from the registry. Returns true if the
// doc was registered. Safe to call multiple times.
func (r *Runtime) closeDoc(roomID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.docs[roomID]; !ok {
		return false
	}
	delete(r.docs, roomID)
	return true
}

// SetImportWarnings records the warnings produced while bootstrapping
// the given room's Y.Doc. Stored on the runtime (not the handle) so the
// OnConnect ServerHelloFn can pop them by roomID without needing the
// broker to thread the handle through.
//
// Called from the bootstrap closure once parse finishes. A subsequent
// PopImportWarnings drains the entry — there's no expiry beyond that;
// cold rooms accumulate at most one entry per bootstrap.
func (r *Runtime) SetImportWarnings(roomID string, warnings []translate.Warning) {
	r.importWarningsMu.Lock()
	defer r.importWarningsMu.Unlock()
	r.importWarnings[roomID] = warnings
}

// PopImportWarnings returns and clears the warnings for the given room.
// Returns nil if no warnings were recorded (or they've already been popped).
//
// The OnConnect handler calls this once per connection. The first
// connection in a freshly-bootstrapped room sees the warnings; later
// joiners see nil — by design, since the warnings describe an import
// event that happened once at room start.
func (r *Runtime) PopImportWarnings(roomID string) []translate.Warning {
	r.importWarningsMu.Lock()
	defer r.importWarningsMu.Unlock()
	w := r.importWarnings[roomID]
	delete(r.importWarnings, roomID)
	return w
}

// textDocHandle is the broker's handle on one room's server-side Y.Doc.
type textDocHandle struct {
	runtime *Runtime
	id      string

	mu     sync.Mutex
	doc    *ycrdt.Doc // nil after Close
	closed bool
}

// ApplyUpdate folds an inbound MsgDocUpdate payload into the server's
// mirror of the room's Y.Doc.
//
// y-crdt's ApplyUpdate logs and silently returns on malformed bytes
// rather than surfacing a decode error. The defer/recover guards
// against that contract regressing — a future panic-on-bad-input
// change in the library would otherwise take down the broker
// goroutine on hostile client input.
func (h *textDocHandle) ApplyUpdate(payload []byte) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed || h.doc == nil {
		return fmt.Errorf("text: ApplyUpdate on closed room %s", h.id)
	}
	var applyErr error
	func() {
		defer func() {
			if r := recover(); r != nil {
				applyErr = fmt.Errorf("text: ApplyUpdate panic for room %s: %v", h.id, r)
			}
		}()
		ycrdt.ApplyUpdate(h.doc, payload, nil)
	}()
	return applyErr
}

// EncodeStateAsUpdate returns the bytes a new joiner needs to catch
// up to the room's current state. Wrapped by the broker in a
// MsgSyncReply frame.
func (h *textDocHandle) EncodeStateAsUpdate() ([]byte, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed || h.doc == nil {
		return nil, fmt.Errorf("text: EncodeStateAsUpdate on closed room %s", h.id)
	}
	return ycrdt.EncodeStateAsUpdate(h.doc, nil), nil
}

// Close releases the room's Y.Doc so it can be garbage-collected.
func (h *textDocHandle) Close() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return nil
	}
	h.closed = true
	h.doc = nil
	h.runtime.closeDoc(h.id)
	return nil
}
