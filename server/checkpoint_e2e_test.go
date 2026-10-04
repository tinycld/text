package text

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	ycrdt "github.com/skyterra/y-crdt"

	"tinycld.org/core/realtime"
	"tinycld.org/packages/text/translate"
)

// addCheckpointCollection extends setupTestApp's schema with the
// realtime_doc_checkpoints collection so the production store can write
// against the test app. Mirrors core's migration.
func addCheckpointCollection(t *testing.T, app *tests.TestApp) {
	t.Helper()
	col := core.NewBaseCollection(realtime.CheckpointCollection)
	col.Fields.Add(&core.TextField{Name: "room_kind", Required: true, Max: 64})
	col.Fields.Add(&core.TextField{Name: "room_id", Required: true, Max: 64})
	col.Fields.Add(&core.NumberField{Name: "epoch", Required: true, Min: ptrFloat(1), OnlyInt: true})
	col.Fields.Add(&core.TextField{Name: "fingerprint", Max: 512})
	col.Fields.Add(&core.TextField{Name: "state", Required: true, Max: 40_000_000})
	col.Fields.Add(&core.AutodateField{Name: "created", OnCreate: true})
	col.Fields.Add(&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true})
	col.AddIndex("idx_realtime_doc_checkpoints_room", true, "room_kind, room_id", "")
	if err := app.Save(col); err != nil {
		t.Fatalf("create %s: %v", realtime.CheckpointCollection, err)
	}
}

func ptrFloat(v float64) *float64 { return &v }

// paragraphUpdate builds a client-style update that puts one paragraph
// into the ProseMirror root, the shape the docx flush can serialize.
func paragraphUpdate(t *testing.T, text string) []byte {
	t.Helper()
	pm, err := json.Marshal(map[string]any{
		"type": "doc",
		"content": []any{map[string]any{
			"type":    "paragraph",
			"content": []any{map[string]any{"type": "text", "text": text}},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return buildUpdateBytes(t, func(doc *ycrdt.Doc) {
		if err := translate.SeedFromPMJSON(doc, pm); err != nil {
			t.Fatalf("SeedFromPMJSON: %v", err)
		}
	})
}

// textEnv wires the production realtime registration against a test app
// and a private broker, so a test drives the whole open / park / evict /
// reopen path the way the server does.
type textEnv struct {
	app     *tests.TestApp
	broker  *realtime.Broker
	runtime *Runtime
	store   *realtime.PocketBaseCheckpointStore
}

func newTextEnv(t *testing.T) *textEnv {
	t.Helper()
	t.Cleanup(realtime.ResetRegistryForTest)
	app := setupTestApp(t)
	addCheckpointCollection(t, app)
	runtime := NewRuntime()
	runtime.SetBootstrap(makeDocxBootstrap(app, runtime))
	registerRealtime(app, runtime)
	broker := realtime.NewBroker()
	t.Cleanup(broker.Close)
	return &textEnv{app: app, broker: broker, runtime: runtime, store: realtime.NewPocketBaseCheckpointStore(app)}
}

func (e *textEnv) stateOf(t *testing.T, itemID string) []byte {
	t.Helper()
	handle := e.runtime.handleFor(itemID)
	if handle == nil {
		t.Fatalf("runtime has no handle for room %q", itemID)
	}
	state, err := handle.EncodeStateAsUpdate()
	if err != nil {
		t.Fatalf("EncodeStateAsUpdate: %v", err)
	}
	return state
}

// A document survives the room emptying (parked), the park expiring
// (checkpointed and closed) and the reopen from the stored state, as the
// SAME incarnation: the epoch never changes and the content is there
// once. Every reopen under the journal re-seeded from the docx instead,
// and a client's surviving document then duplicated the content.
func TestCheckpoint_ReopenKeepsTheDocumentAcrossParkAndEviction(t *testing.T) {
	env := newTextEnv(t)
	item := seedDriveItem(t, env.app, "park.docx", nil)
	client := realtime.NewClientForTest("editor")

	room := env.broker.JoinForTest(roomKindText, item.Id, client)
	epoch := room.DocEpoch()
	if epoch == 0 {
		t.Fatal("a seeded room has no epoch")
	}
	env.broker.RouteFrameForTest(roomKindText, item.Id, client, buildDocUpdateFrame(paragraphUpdate(t, "parked-content")))
	env.broker.LeaveForTest(client)

	second := realtime.NewClientForTest("editor")
	again := env.broker.JoinForTest(roomKindText, item.Id, second)
	if got := env.broker.OpenedFromForTest(roomKindText, item.Id); got != "parked" {
		t.Fatalf("reopened from %q; want parked", got)
	}
	if again.DocEpoch() != epoch {
		t.Fatalf("epoch changed across a park: %d -> %d", epoch, again.DocEpoch())
	}
	if n := bytes.Count(env.stateOf(t, item.Id), []byte("parked-content")); n != 1 {
		t.Fatalf("content appears %d times after the reopen; want 1", n)
	}
	env.broker.LeaveForTest(second)

	env.broker.EvictIdleForTest(time.Now().Add(realtime.ParkIdle + time.Second))
	cp, found, err := env.store.Load(roomKindText, item.Id)
	if err != nil || !found {
		t.Fatalf("checkpoint after eviction: found=%v err=%v", found, err)
	}
	if cp.Epoch != epoch {
		t.Fatalf("stored epoch = %d; want %d", cp.Epoch, epoch)
	}
	if env.runtime.handleFor(item.Id) != nil {
		t.Fatal("the evicted document is still registered in the runtime")
	}

	third := env.broker.JoinForTest(roomKindText, item.Id, realtime.NewClientForTest("editor"))
	if got := env.broker.OpenedFromForTest(roomKindText, item.Id); got != "checkpoint" {
		t.Fatalf("reopened from %q; want checkpoint", got)
	}
	if third.DocEpoch() != epoch {
		t.Fatalf("epoch changed across a checkpoint: %d -> %d", epoch, third.DocEpoch())
	}
	if n := bytes.Count(env.stateOf(t, item.Id), []byte("parked-content")); n != 1 {
		t.Fatalf("content appears %d times after the checkpoint reopen; want 1", n)
	}
}

// Deleting the document drops its parked Y.Doc and its checkpoint row.
func TestCheckpoint_DeleteDropsTheParkedDocumentAndRow(t *testing.T) {
	env := newTextEnv(t)
	item := seedDriveItem(t, env.app, "delete.docx", nil)
	client := realtime.NewClientForTest("editor")
	room := env.broker.JoinForTest(roomKindText, item.Id, client)
	if err := env.store.Save(roomKindText, item.Id, realtime.Checkpoint{Epoch: room.DocEpoch(), Fingerprint: "x", State: []byte{1}}); err != nil {
		t.Fatal(err)
	}
	env.broker.LeaveForTest(client)
	// DropRoom acts on the process-wide broker; this test's broker holds the
	// parked document, so the row is what the hook's effect shows here.
	if err := env.app.Delete(item); err != nil {
		t.Fatalf("Delete drive_item: %v", err)
	}
	if _, found, _ := env.store.Load(roomKindText, item.Id); found {
		t.Fatal("the checkpoint row survived the drive item's deletion")
	}
}

// TestRealtime_RejectsClientAuthorshipWrite verifies that Register wires
// validateUpdate into RoomKindOptions.UpdateContentValidator so the broker
// rejects inbound MsgDocUpdate frames that mutate protected Y.Doc roots
// (clientAuthors, clientFirstSeen, editEvents). Together with core's
// TestUpdateContentValidatorRejectsUpdate — which proves the broker calls
// UpdateContentValidator when set and drops the frame on a non-nil return
// (no server-doc apply, no fan-out) — this completes
// the end-to-end guarantee that a client-forged authorship write never
// reaches the document.
//
// The text package can't drive the broker pipeline from outside the
// realtime package (route, join, runConnection are unexported), so this
// test does the two pieces it CAN cover from here:
//  1. Run the production wiring (text.Register) and assert
//     UpdateContentValidator was wired (not left nil).
//  2. Hand the wired function a Yjs update that writes to clientAuthors —
//     the exact malicious-client shape — and assert it returns an error.
//
// Core's broker-integration test then closes the loop: a non-nil error
// from this exact function drops the frame before the document.
func TestRealtime_RejectsClientAuthorshipWrite(t *testing.T) {
	t.Cleanup(realtime.ResetRegistryForTest)

	// pocketbase.New() is enough for Register: it touches only the hook
	// registry (OnRecordAfterDeleteSuccess) and the realtime room-kind
	// registry, neither of which needs the DB to be bootstrapped.
	app := pocketbase.New()
	Register(app)

	opts, ok := realtime.LookupOptionsForTest(roomKindText)
	if !ok {
		t.Fatalf("Register did not register the %q room kind", roomKindText)
	}
	if opts.UpdateContentValidator == nil {
		t.Fatalf("Register did not wire UpdateContentValidator for %q", roomKindText)
	}

	// Hand-craft a Yjs update that writes to "clientAuthors" — the
	// authorship map a malicious client would attempt to forge. Same
	// ycrdt API the validator's isolated tests use (see
	// suggestions_authz_test.go) so we know the bytes are well-formed.
	src := ycrdt.NewDoc("src", false, nil, nil, false)
	authors := src.GetMap("clientAuthors").(*ycrdt.YMap)
	authors.Set("999", "spoofed-author-id")
	spoofed := ycrdt.EncodeStateAsUpdate(src, nil)

	if err := opts.UpdateContentValidator("doc-1", spoofed); err == nil {
		t.Fatal("wired validator admitted a clientAuthors write; expected rejection")
	}
}

// TestRealtime_EditorWritesOK_ClientAuthorshipBlocked is the
// Phase 1 e2e smoke: confirm that an editor-role client connected to a
// real text-kind room broker can write ordinary updates AND that the
// broker drops updates writing to protected authorship Y.Doc roots,
// all through the real route() path (not via a stubbed kind, not via
// the validator function in isolation).
//
// Together with the existing coverage:
//   - core's TestUpdateContentValidatorRejectsUpdate proves the broker
//     calls UpdateContentValidator and drops the frame on a non-nil
//     return — but uses a stub kind, not the text-kind path.
//   - TestRealtime_RejectsClientAuthorshipWrite (above) proves
//     Register wires validateUpdate into the registry — but calls the
//     wired function directly, not through Broker.route().
//
// This test closes the gap: it builds the same RoomKindOptions
// text.Register builds (mirroring its body), registers the kind for
// real, then drives two frames through Broker.RouteFrameForTest. The
// first writes legitimate content to the "default" XML fragment and
// MUST land in the server-side mirror. The second writes to
// "clientAuthors" — the malicious-client shape — and MUST be dropped
// by the broker before reaching the mirror.
//
// We construct the wiring locally rather than calling Register because
// Register takes *pocketbase.PocketBase and the test harness exposes
// *tests.TestApp. Each RoomKindOptions field below is the same value
// Register would set (cross-reference register.go); the test passes iff
// that exact bundle, plumbed through a real Broker, drops the spoofed
// frame while accepting the legitimate one.
//
// Because the wiring is local, a refactor that changes WHICH field
// Register populates with the validator (e.g. moving the protection
// into a wrapper or a new OnConnect-time check) would still pass this
// test even though production would break. That drift is guarded by
// TestRealtime_RejectsClientAuthorshipWrite above, which DOES call
// Register and looks up the registered options via LookupOptionsForTest.
// The two tests are complementary: that one guards Register's wiring,
// this one guards the broker's route() integration.
func TestRealtime_EditorWritesOK_ClientAuthorshipBlocked(t *testing.T) {
	t.Cleanup(realtime.ResetRegistryForTest)

	app := setupTestApp(t)

	item := seedDriveItem(t, app, "e2e-validator.docx", nil)

	// No bootstrap: the room starts with an empty Y.Doc, which is what
	// we want — the test asserts on content WE write through the
	// broker, not on bootstrapped fixture data.
	runtime := NewRuntime()

	flush := makeProductionFlush(app, runtime)
	saveCoordinator := realtime.NewSaveCoordinator(flush)
	saveCoordinator.SetKind(roomKindText)

	// Mirror text.Register's RegisterRoomKindWith call. Authorize is
	// required by the registry but the join path bypasses it (only
	// handleConnect calls it), so a permissive no-op is fine here.
	realtime.RegisterRoomKindWith(roomKindText, realtime.RoomKindOptions{
		Authorize:       func(_ *core.Record, _ string) error { return nil },
		RuntimeProvider: runtime,
		OnRoomCreate:    saveCoordinator.OnRoomCreate,
		OnDocUpdate:     saveCoordinator.OnDocUpdate,
		OnEmpty:         saveCoordinator.OnRoomEmpty,
		// WritePredicate gates on Client.ReadOnly(). Test clients
		// constructed via NewClientForTest default to readOnly=false,
		// so this predicate admits them.
		WritePredicate: func(c *realtime.Client, _ string) bool {
			return !c.ReadOnly()
		},
		// The piece under test: the content-level validator. If a
		// future refactor of route() ever skipped this for any reason
		// (e.g. anonymous shares, oversize bypass) this test breaks.
		UpdateContentValidator: validateUpdate,
	})

	broker := realtime.NewBroker()
	client := realtime.NewClientForTest("editor-user-id")

	// Frame 1: legitimate write to the "default" XML fragment (the
	// ProseMirror root). Must be accepted and applied to the
	// server-side mirror.
	legitPayload := buildUpdateBytes(t, func(doc *ycrdt.Doc) {
		frag := doc.GetXmlFragment("default").(*ycrdt.YXmlFragment)
		text := ycrdt.NewYXmlText()
		if text.Map == nil {
			text.Map = make(map[string]*ycrdt.Item)
		}
		text.Insert(0, "valid-editor-content", nil)
		frag.Push([]any{text})
	})
	legitFrame := buildDocUpdateFrame(legitPayload)

	// Frame 2: spoofed write to clientAuthors. The broker MUST drop
	// this in route() before mirror apply / fan-out.
	spoofedPayload := buildUpdateBytes(t, func(doc *ycrdt.Doc) {
		m := doc.GetMap("clientAuthors").(*ycrdt.YMap)
		m.Set("999", "spoofed-author-id-9999")
	})
	spoofedFrame := buildDocUpdateFrame(spoofedPayload)

	broker.RouteFrameForTest(roomKindText, item.Id, client, legitFrame)
	broker.RouteFrameForTest(roomKindText, item.Id, client, spoofedFrame)

	// Read the server-side mirror state and assert both halves of
	// the contract.
	runtime.mu.Lock()
	handle := runtime.handles[item.Id]
	runtime.mu.Unlock()
	if handle == nil {
		t.Fatalf("runtime has no handle for room %q after broker activity", item.Id)
	}

	state, err := handle.EncodeStateAsUpdate()
	if err != nil {
		t.Fatalf("EncodeStateAsUpdate: %v", err)
	}

	if !bytes.Contains(state, []byte("valid-editor-content")) {
		t.Errorf("legitimate update was not applied to the server mirror; "+
			"state (%d bytes) does not contain expected content", len(state))
	}
	if bytes.Contains(state, []byte("spoofed-author-id-9999")) {
		t.Errorf("spoofed clientAuthors write leaked into the server mirror — "+
			"the broker did not drop the frame; state (%d bytes) contains "+
			"the forged value", len(state))
	}
}

// buildDocUpdateFrame wraps a Yjs update payload in a MsgDocUpdate wire
// frame: 16 zero bytes (client ID prefix — unused in route()'s
// MsgDocUpdate branch) + 1 byte msgType + payload.
func buildDocUpdateFrame(payload []byte) []byte {
	const clientIDLen = 16
	frame := make([]byte, clientIDLen+1+len(payload))
	frame[clientIDLen] = byte(realtime.MsgDocUpdate)
	copy(frame[clientIDLen+1:], payload)
	return frame
}
