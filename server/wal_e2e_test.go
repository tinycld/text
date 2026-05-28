package text

import (
	"bytes"
	"math"
	"testing"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	ycrdt "github.com/skyterra/y-crdt"

	"tinycld.org/core/realtime"
)

// addWALCollection extends setupTestApp's schema with the
// realtime_doc_updates collection so PocketBaseJournal can write rows
// against the test app. Mirrors the migration in core's pb_migrations
// and the setupJournalTestApp helper in core's realtime tests.
func addWALCollection(t *testing.T, app *tests.TestApp) {
	t.Helper()
	col := core.NewBaseCollection(realtime.JournalCollection)
	col.Fields.Add(&core.TextField{Name: "room_kind", Required: true, Max: 64})
	col.Fields.Add(&core.TextField{Name: "room_id", Required: true, Max: 64})
	col.Fields.Add(&core.NumberField{Name: "seq", Required: true, Min: ptrFloat(1), OnlyInt: true})
	col.Fields.Add(&core.TextField{Name: "update", Required: true, Max: 358400})
	col.Fields.Add(&core.AutodateField{Name: "created", OnCreate: true})
	col.AddIndex("idx_realtime_doc_updates_room_seq", true, "room_kind, room_id, seq", "")
	col.AddIndex("idx_realtime_doc_updates_room", false, "room_kind, room_id", "")
	if err := app.Save(col); err != nil {
		t.Fatalf("create %s: %v", realtime.JournalCollection, err)
	}
}

func ptrFloat(v float64) *float64 { return &v }

// sampleText is the YText payload we seed into the source Y.Doc when
// building the journal update. Asserting on it after replay verifies
// the update actually folded in — a stronger check than a raw byte
// threshold, since a partial / corrupted decode could in principle
// produce non-trivial encoded state without preserving content.
const sampleText = "hello WAL"

// sampleTextKey is the YText name inside the sample Y.Doc. Reading
// back through doc.GetText(sampleTextKey) is how we confirm replay
// reproduced the original content; if the wire path lost the update,
// the doc returns an empty YText for this key.
const sampleTextKey = "wal-sample"

// buildSampleUpdate constructs a Y.Doc update by mutating a fresh
// Y.Doc and encoding its state. The bytes are what would normally
// arrive over the wire from a peer's edit. The shape is opaque to
// the WAL — we only need bytes that ApplyUpdate accepts and that
// produce a non-trivial state when folded in.
//
// y-crdt's Go API uses doc.Transact(fn, origin) (see
// compatibility_test.go in the y-crdt source). The Transact closure
// receives a *Transaction implicitly used by the YText.Insert call.
func buildSampleUpdate(t *testing.T) []byte {
	t.Helper()
	doc := ycrdt.NewDoc("sample-source", false, nil, nil, false)
	ytext := doc.GetText(sampleTextKey)
	doc.Transact(func(_ *ycrdt.Transaction) {
		ytext.Insert(0, sampleText, nil)
	}, nil)
	return ycrdt.EncodeStateAsUpdate(doc, nil)
}

// TestRealtimeWAL_ReplayAfterSimulatedCrash exercises the durability
// invariant: a Yjs update appended to the journal but never reflected
// in the docx snapshot must reach the in-memory Y.Doc on the next room
// bootstrap. This is what protects against SIGKILL between accept and
// flush.
//
// Flow:
//  1. Build a TestApp with both drive_items and realtime_doc_updates.
//  2. Seed an empty drive_item; create a journal row at seq=1.
//  3. "Cold start": construct a fresh Runtime, bootstrap (empty docx),
//     then call Replay manually (simulating Room.newRoom's flow).
//  4. Verify the resulting Y.Doc has non-trivial state — i.e. the
//     journal row was folded in.
func TestRealtimeWAL_ReplayAfterSimulatedCrash(t *testing.T) {
	app := setupTestApp(t)
	addWALCollection(t, app)
	journal := realtime.NewPocketBaseJournal(app)

	item := seedDriveItem(t, app, "wal-replay.docx", nil)

	// Pretend the broker accepted an update before "crashing": one
	// row in the journal, no docx snapshot reflects it.
	pendingUpdate := buildSampleUpdate(t)
	if err := journal.Append(roomKindText, item.Id, 1, pendingUpdate); err != nil {
		t.Fatalf("Append: %v", err)
	}

	// Cold start: fresh Runtime, bootstrap reads empty docx, then
	// Replay folds the pending update back in. In production, the
	// broker's newRoom does both steps; here we drive them directly
	// because we don't want a full broker plumbed up for one test.
	runtime := NewRuntime()
	runtime.SetBootstrap(makeDocxBootstrap(app, runtime))
	handle, err := runtime.NewDoc(item.Id)
	if err != nil {
		t.Fatalf("NewDoc: %v", err)
	}
	defer func() { _ = handle.Close() }()

	if err := journal.Replay(roomKindText, item.Id, func(_ int64, payload []byte) error {
		return handle.ApplyUpdate(payload)
	}); err != nil {
		t.Fatalf("Replay: %v", err)
	}

	state, err := handle.EncodeStateAsUpdate()
	if err != nil {
		t.Fatalf("EncodeStateAsUpdate: %v", err)
	}
	// An empty Y.Doc encodes to ~2 bytes (just a state header) per
	// EncodeStateAsUpdate. After replaying our sample update — which
	// encodes to ~25 bytes on its own — the state must reflect the
	// folded-in content. A threshold of 10 catches "empty" without
	// being sensitive to y-crdt's exact encoding overhead.
	if len(state) < 10 {
		t.Fatalf("Y.Doc state after replay is only %d bytes; expected real content folded in", len(state))
	}

	// Round-trip into a fresh Doc and assert the YText content
	// survived. This is a stronger check than a byte threshold: it
	// verifies the journal payload semantically equals what a peer
	// originally produced, not just that "some bytes" reached the
	// runtime.
	verify := ycrdt.NewDoc("verify", false, nil, nil, false)
	ycrdt.ApplyUpdate(verify, state, nil)
	if got := verify.GetText(sampleTextKey).ToString(); got != sampleText {
		t.Fatalf("YText after replay: got %q, want %q", got, sampleText)
	}
}

// TestRealtimeWAL_FlushTruncatesJournal verifies the truncate-after-
// successful-flush contract at the journal layer: rows up to the
// snapshot's high-water seq disappear from PB after Truncate, so the
// next Replay sees no work to do.
//
// The full chain (SaveCoordinator → PocketBaseJournal.Truncate) is
// covered by save_coordinator_test.go with a recording journal mock;
// this test confirms the bottom of the chain (PB rows actually go
// away) end-to-end against a real PB test app.
func TestRealtimeWAL_FlushTruncatesJournal(t *testing.T) {
	app := setupTestApp(t)
	addWALCollection(t, app)
	journal := realtime.NewPocketBaseJournal(app)

	item := seedDriveItem(t, app, "wal-truncate.docx", nil)

	// Append three rows. Real broker traffic would produce more, but
	// three is plenty to verify the "<=N" semantics.
	for seq := int64(1); seq <= 3; seq++ {
		if err := journal.Append(roomKindText, item.Id, seq, []byte{byte(seq)}); err != nil {
			t.Fatalf("Append seq=%d: %v", seq, err)
		}
	}

	// Simulate a successful flush whose snapshotSeq captured seq=3.
	if err := journal.Truncate(roomKindText, item.Id, 3); err != nil {
		t.Fatalf("Truncate: %v", err)
	}

	// Confirm replay now sees nothing — the broker can boot fresh.
	calls := 0
	if err := journal.Replay(roomKindText, item.Id, func(int64, []byte) error {
		calls++
		return nil
	}); err != nil {
		t.Fatalf("Replay after truncate: %v", err)
	}
	if calls != 0 {
		t.Fatalf("Replay called apply %d times after truncate; want 0", calls)
	}
}

// TestRealtimeWAL_CleanupOnDriveItemDelete confirms the cascade hook
// wired in Register clears WAL rows when their drive_item is deleted.
// Without this hook, deleting a document would leak journal rows that
// nothing would ever truncate (the room is gone).
func TestRealtimeWAL_CleanupOnDriveItemDelete(t *testing.T) {
	app := setupTestApp(t)
	addWALCollection(t, app)

	// Register the production hooks against the test app. Register
	// expects a *pocketbase.PocketBase, but our test has a *tests.TestApp;
	// register the delete hook directly with the same closure to keep
	// this test independent of the realtime registry side-effect.
	journal := realtime.NewPocketBaseJournal(app)
	app.OnRecordAfterDeleteSuccess("drive_items").BindFunc(func(e *core.RecordEvent) error {
		if err := journal.Truncate(roomKindText, e.Record.Id, math.MaxInt64); err != nil {
			app.Logger().Warn("text: WAL cleanup on drive_items delete failed",
				"itemID", e.Record.Id, "err", err)
		}
		return e.Next()
	})

	item := seedDriveItem(t, app, "wal-cleanup.docx", nil)

	// Append a WAL row for this drive_item.
	if err := journal.Append(roomKindText, item.Id, 1, []byte{0x01}); err != nil {
		t.Fatalf("Append: %v", err)
	}

	// Delete the drive_item — the hook should fire and clear the WAL.
	if err := app.Delete(item); err != nil {
		t.Fatalf("Delete drive_item: %v", err)
	}

	// Confirm the WAL is empty for this room.
	calls := 0
	if err := journal.Replay(roomKindText, item.Id, func(int64, []byte) error {
		calls++
		return nil
	}); err != nil {
		t.Fatalf("Replay: %v", err)
	}
	if calls != 0 {
		t.Fatalf("WAL rows after drive_item delete = %d; want 0", calls)
	}
}

// TestRealtimeWAL_RejectsClientAuthorshipWrite verifies that Register wires
// validateUpdate into RoomKindOptions.UpdateContentValidator so the broker
// rejects inbound MsgDocUpdate frames that mutate protected Y.Doc roots
// (clientAuthors, clientFirstSeen, editEvents). Together with core's
// TestUpdateContentValidatorRejectsUpdate — which proves the broker calls
// UpdateContentValidator when set and drops the frame on a non-nil return
// (no journal append, no server-doc apply, no fan-out) — this completes
// the end-to-end guarantee that a client-forged authorship write never
// reaches the journal.
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
// from this exact function drops the frame before the journal.
func TestRealtimeWAL_RejectsClientAuthorshipWrite(t *testing.T) {
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

// TestRealtimeWAL_Phase1_EditorWritesOK_ClientAuthorshipBlocked is the
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
//   - TestRealtimeWAL_RejectsClientAuthorshipWrite (above) proves
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
func TestRealtimeWAL_Phase1_EditorWritesOK_ClientAuthorshipBlocked(t *testing.T) {
	t.Cleanup(realtime.ResetRegistryForTest)

	app := setupTestApp(t)
	addWALCollection(t, app)

	item := seedDriveItem(t, app, "wal-e2e-validator.docx", nil)

	runtime := NewRuntime()
	// No bootstrap: NewDoc starts with an empty Y.Doc, which is what
	// we want — the test asserts on content WE write through the
	// broker, not on bootstrapped fixture data.
	t.Cleanup(runtime.Stop)

	journal := realtime.NewPocketBaseJournal(app)
	flush := makeProductionFlush(app, runtime)
	saveCoordinator := realtime.NewSaveCoordinator(flush)
	saveCoordinator.SetJournal(roomKindText, journal)

	// Mirror text.Register's RegisterRoomKindWith call. Authorize is
	// required by the registry but the join path bypasses it (only
	// handleConnect calls it), so a permissive no-op is fine here.
	realtime.RegisterRoomKindWith(roomKindText, realtime.RoomKindOptions{
		Authorize:       func(_ *core.Record, _ string) error { return nil },
		RuntimeProvider: runtime,
		Journal:         journal,
		OnRoomCreate:    saveCoordinator.OnRoomCreate,
		OnDocUpdate:     saveCoordinator.OnDocUpdate,
		OnDocUpdateSeq:  saveCoordinator.NoteSeq,
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
	// ProseMirror root). Must be accepted, journaled, and applied to
	// the server-side mirror.
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
	// this in route() before journal append / mirror apply / fan-out.
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
// MsgDocUpdate branch) + 1 byte msgType + payload. Mirrors the frame
// construction in core's TestRoomRouteAppendsBeforeFanout.
func buildDocUpdateFrame(payload []byte) []byte {
	const clientIDLen = 16
	frame := make([]byte, clientIDLen+1+len(payload))
	frame[clientIDLen] = byte(realtime.MsgDocUpdate)
	copy(frame[clientIDLen+1:], payload)
	return frame
}
