package text

import (
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	ycrdt "github.com/skyterra/y-crdt"

	"tinycld.org/core/realtime"
)

// TestEditEvents_SoloWriterSkipsEmissionByDesign verifies the audience
// gate added in the PR-review pass: when the only writer in the room
// is the sender themselves (i.e. a solo author editing in private,
// with no other writer-class peers to consume the activity feed), the
// authorship stamper skips buffer.Note so no EditEvent rows land in
// the server doc's editEvents Y.Array.
//
// Earlier versions of this test asserted that a single client's two
// frames produced one aggregated EditEvent — that was correct under
// the prior "always emit" semantics. After the read-only design
// decision (see screens/[id].tsx + authorship_stamper.go), editEvents
// are an audience-facing artifact whose consumers are OTHER writers'
// activity tabs / notify hooks; read-only viewers don't see them at
// all. A solo writer thus has nobody to consume them, and the right
// behavior is to skip the write rather than journal forever.
//
// The companion test below (TestEditEvents_TwoWriters_EmitsBothEvents)
// re-establishes the two-writer scenario the prior test partly covered
// AND additionally pins that BOTH writers' frames emit when each
// other is present as audience.
func TestEditEvents_SoloWriterSkipsEmissionByDesign(t *testing.T) {
	t.Cleanup(realtime.ResetRegistryForTest)

	// Shorten the debounce window so the test completes in ~200ms
	// instead of the production 60s. Restored on cleanup so other
	// tests that run after this one see the original value.
	origWindow := WindowDuration
	WindowDuration = 50 * time.Millisecond
	t.Cleanup(func() { WindowDuration = origWindow })

	app := setupAuthTestApp(t)
	alice := seedAuthorshipFixture(t, app, "alice@e2e.test", "doc.docx")
	itemID := alice.itemID

	runtime := NewRuntime()
	t.Cleanup(runtime.Stop)

	// Mirror text.Register's wiring: RuntimeProvider mints the
	// serverDoc, OnRoomCreate registers the *Room + per-room buffer,
	// OnDocUpdateContent drives the stamper → buffer.Note path. No
	// Journal — PublishDocUpdate handles nil journal gracefully.
	realtime.RegisterRoomKindWith(roomKindText, realtime.RoomKindOptions{
		Authorize:       func(_ *core.Record, _ string) error { return nil },
		RuntimeProvider: runtime,
		OnRoomCreate: func(_ string, _ realtime.DocHandle, room *realtime.Room) {
			runtime.noteRoom(itemID, room)
		},
		OnDocUpdateContent: makeAuthorshipStamper(runtime),
		WritePredicate: func(c *realtime.Client, _ string) bool {
			return !c.ReadOnly()
		},
		UpdateContentValidator: validateUpdate,
	})

	broker := realtime.NewBroker()
	conn := realtime.NewClientForTest(alice.userID)

	// Single source doc → both frames carry the same clientID. The
	// second frame is an incremental delta against the first's state
	// vector, so the two frames represent two distinct edits the
	// stamper notes separately even though they share a clientID.
	src := ycrdt.NewDoc("alice-src", false, nil, nil, false)
	installYXmlElementPatcher(src)
	src.Transact(func(_ *ycrdt.Transaction) {
		frag := src.GetXmlFragment("default").(*ycrdt.YXmlFragment)
		txt := ycrdt.NewYXmlText()
		if txt.Map == nil {
			txt.Map = make(map[string]*ycrdt.Item)
		}
		txt.Insert(0, "first-edit", nil)
		frag.Push([]any{txt})
	}, nil)
	firstUpdate := ycrdt.EncodeStateAsUpdate(src, nil)
	firstSV := ycrdt.EncodeStateVector(src, nil, ycrdt.NewUpdateEncoderV1())

	src.Transact(func(_ *ycrdt.Transaction) {
		src.GetText("scratch").Insert(0, "second-edit", nil)
	}, nil)
	secondUpdate := ycrdt.EncodeStateAsUpdate(src, firstSV)
	aliceClientID := uint32(src.ClientID)

	broker.RouteFrameForTest(roomKindText, itemID, conn, buildDocUpdateFrame(firstUpdate))
	broker.RouteFrameForTest(roomKindText, itemID, conn, buildDocUpdateFrame(secondUpdate))

	// Sleep past WindowDuration so the per-clientID timer fires and
	// the flush callback writes the single emitted EditEvent into the
	// server doc's editEvents Y.Array.
	time.Sleep(200 * time.Millisecond)

	serverDoc := runtime.docFor(itemID)
	if serverDoc == nil {
		t.Fatalf("runtime has no server doc for %q after routing frames", itemID)
	}
	arr := serverDoc.GetArray("editEvents")
	if arr == nil {
		t.Fatalf("editEvents root missing from server doc")
	}
	// Solo writer + no audience → no buffer.Note → no editEvents.
	// aliceClientID is only kept in scope above to make
	// the test setup match a realistic stamping flow; they are
	// intentionally unused in the assertions because the design says
	// nothing should land.
	_ = aliceClientID
	if arr.Length != 0 {
		t.Fatalf("editEvents length = %d after solo-writer window; want 0 by audience-gate design", arr.Length)
	}
}

// TestEditEvents_TwoWriters_EmitsBothEvents drives one frame each from
// two distinct WRITER-class clientIDs co-present in the room. The
// buffer arms a separate timer per clientID, so both windows close
// independently within the shortened WindowDuration. The flush
// callback runs on each timer's goroutine; both writes go through
// handle.publishEditEvent, which serializes through the handle mutex,
// so the two YArray pushes don't corrupt each other. After the window
// closes, editEvents should contain exactly two entries, one per
// clientID, each mapped to the right authorID.
//
// The strongest check is that BOTH entries surface — a missed flush
// (e.g. timer cleared by a concurrent reset) would show up as a
// length-1 array. The clientID → authorID mapping check confirms the
// buffer didn't cross-pollinate windows between clients.
//
// Both connections JOIN the room before either frame is routed (via
// JoinForTest), so the audience gate added in the read-only design
// pass (HasOtherWriter) sees the peer as present when each frame
// fires.
func TestEditEvents_TwoWriters_EmitsBothEvents(t *testing.T) {
	t.Cleanup(realtime.ResetRegistryForTest)

	origWindow := WindowDuration
	WindowDuration = 50 * time.Millisecond
	t.Cleanup(func() { WindowDuration = origWindow })

	app := setupAuthTestApp(t)
	alice := seedAuthorshipFixture(t, app, "alice@e2e.test", "doc.docx")
	itemID := alice.itemID
	bob := mustCreateUser(t, app, "bob@e2e.test")

	runtime := NewRuntime()
	t.Cleanup(runtime.Stop)

	realtime.RegisterRoomKindWith(roomKindText, realtime.RoomKindOptions{
		Authorize:       func(_ *core.Record, _ string) error { return nil },
		RuntimeProvider: runtime,
		OnRoomCreate: func(_ string, _ realtime.DocHandle, room *realtime.Room) {
			runtime.noteRoom(itemID, room)
		},
		OnDocUpdateContent: makeAuthorshipStamper(runtime),
		WritePredicate: func(c *realtime.Client, _ string) bool {
			return !c.ReadOnly()
		},
		UpdateContentValidator: validateUpdate,
	})

	broker := realtime.NewBroker()
	aliceConn := realtime.NewClientForTest(alice.userID)
	bobConn := realtime.NewClientForTest(bob.Id)

	// Two source docs with distinct, library-auto-generated clientIDs.
	aliceDoc := ycrdt.NewDoc("alice-src", false, nil, nil, false)
	installYXmlElementPatcher(aliceDoc)
	aliceDoc.Transact(func(_ *ycrdt.Transaction) {
		frag := aliceDoc.GetXmlFragment("default").(*ycrdt.YXmlFragment)
		txt := ycrdt.NewYXmlText()
		if txt.Map == nil {
			txt.Map = make(map[string]*ycrdt.Item)
		}
		txt.Insert(0, "alice-content", nil)
		frag.Push([]any{txt})
	}, nil)
	aliceUpdate := ycrdt.EncodeStateAsUpdate(aliceDoc, nil)
	aliceClientID := uint32(aliceDoc.ClientID)

	bobDoc := ycrdt.NewDoc("bob-src", false, nil, nil, false)
	installYXmlElementPatcher(bobDoc)
	bobDoc.Transact(func(_ *ycrdt.Transaction) {
		frag := bobDoc.GetXmlFragment("default").(*ycrdt.YXmlFragment)
		txt := ycrdt.NewYXmlText()
		if txt.Map == nil {
			txt.Map = make(map[string]*ycrdt.Item)
		}
		txt.Insert(0, "bob-content", nil)
		frag.Push([]any{txt})
	}, nil)
	bobUpdate := ycrdt.EncodeStateAsUpdate(bobDoc, nil)
	bobClientID := uint32(bobDoc.ClientID)

	if aliceClientID == bobClientID {
		t.Fatalf("alice and bob doc clientIDs collided (%d); test premise broken", aliceClientID)
	}

	// Pre-join BOTH connections before routing the first frame so the
	// audience gate (Room.HasOtherWriter) sees the peer as already
	// present when each MsgDocUpdate lands. Without this the gate
	// would skip buffer.Note on whichever frame arrived first, and the
	// test would intermittently see editEvents.Length == 1.
	broker.JoinForTest(roomKindText, itemID, aliceConn)
	broker.JoinForTest(roomKindText, itemID, bobConn)
	broker.RouteFrameForTest(roomKindText, itemID, aliceConn, buildDocUpdateFrame(aliceUpdate))
	broker.RouteFrameForTest(roomKindText, itemID, bobConn, buildDocUpdateFrame(bobUpdate))

	// Both per-clientID timers fire within this window; both flush
	// callbacks serialize through handle.mu so the YArray ends with
	// both entries intact.
	time.Sleep(200 * time.Millisecond)

	handle := runtime.handleFor(itemID)
	if handle == nil {
		t.Fatalf("runtime has no doc handle for %q after routing frames", itemID)
	}

	// Read the doc under the handle mutex that publishEditEvent takes.
	// A per-clientID flush timer can still be in flight here, and
	// y-crdt's Doc.Get mutates the root map even on a read path, so an
	// unguarded read races the writer rather than merely observing it.
	//
	// Build a clientID → authorID map from the array entries so the
	// assertions don't depend on emission order (the two flush
	// goroutines race, so ordering between alice and bob isn't fixed).
	handle.mu.Lock()
	arr := handle.doc.GetArray("editEvents")
	if arr == nil {
		handle.mu.Unlock()
		t.Fatalf("editEvents root missing from server doc")
	}
	gotLen := arr.Length
	got := map[uint32]string{}
	entries := make([]any, 0, gotLen)
	for i := 0; i < gotLen; i++ {
		entries = append(entries, arr.Get(i))
	}
	handle.mu.Unlock()

	if gotLen != 2 {
		t.Fatalf("editEvents length = %d after two-client windows, want 2", gotLen)
	}
	for i, raw := range entries {
		entry, ok := raw.(map[string]interface{})
		if !ok {
			t.Fatalf("editEvents[%d] is not a map: %T", i, raw)
		}
		cid, _ := entry["clientId"].(int)
		author, _ := entry["authorId"].(string)
		got[uint32(cid)] = author
	}

	if author, ok := got[aliceClientID]; !ok {
		t.Errorf("editEvents missing entry for alice clientID %d (got %v)", aliceClientID, got)
	} else if author != alice.userID {
		t.Errorf("editEvents[alice].authorId = %q, want %q", author, alice.userID)
	}
	if author, ok := got[bobClientID]; !ok {
		t.Errorf("editEvents missing entry for bob clientID %d (got %v)", bobClientID, got)
	} else if author != bob.Id {
		t.Errorf("editEvents[bob].authorId = %q, want %q", author, bob.Id)
	}
}

// TestEditEvents_WriterWithReadOnlyViewerPresentSkipsEmission pins the
// read-only-viewer half of the audience gate: a single writer in a
// room whose only other peer is a READ-ONLY viewer is treated the same
// as a solo writer. EditEvents are not for viewers (by the screen-
// level design decision — see screens/[id].tsx), so the gate skips
// buffer.Note even though the room is "non-empty."
//
// This is the harder direction to get right — the cheap implementation
// "HasWriter" would falsely return true here (the sender is a writer),
// burning WAL volume on entries no audience can read. The correct
// implementation (HasOtherWriter) excludes the sender from the
// audience-presence check.
func TestEditEvents_WriterWithReadOnlyViewerPresentSkipsEmission(t *testing.T) {
	t.Cleanup(realtime.ResetRegistryForTest)

	origWindow := WindowDuration
	WindowDuration = 50 * time.Millisecond
	t.Cleanup(func() { WindowDuration = origWindow })

	app := setupAuthTestApp(t)
	alice := seedAuthorshipFixture(t, app, "alice@e2e.test", "doc.docx")
	itemID := alice.itemID
	viewer := mustCreateUser(t, app, "viewer@e2e.test")

	runtime := NewRuntime()
	t.Cleanup(runtime.Stop)

	realtime.RegisterRoomKindWith(roomKindText, realtime.RoomKindOptions{
		Authorize:       func(_ *core.Record, _ string) error { return nil },
		RuntimeProvider: runtime,
		OnRoomCreate: func(_ string, _ realtime.DocHandle, room *realtime.Room) {
			runtime.noteRoom(itemID, room)
		},
		OnDocUpdateContent: makeAuthorshipStamper(runtime),
		WritePredicate: func(c *realtime.Client, _ string) bool {
			return !c.ReadOnly()
		},
		UpdateContentValidator: validateUpdate,
	})

	broker := realtime.NewBroker()
	aliceConn := realtime.NewClientForTest(alice.userID)
	viewerConn := realtime.NewClientForTest(viewer.Id)
	// Flip the viewer's read-only flag the way OnConnect would for a
	// view-only share role.
	viewerConn.SetReadOnly(true)

	// Pre-join both. Now the room has one writer (alice) + one viewer
	// (viewer). When alice's frame routes, HasOtherWriter(aliceConn)
	// returns false (viewer is read-only; alice is excluded).
	broker.JoinForTest(roomKindText, itemID, aliceConn)
	broker.JoinForTest(roomKindText, itemID, viewerConn)

	aliceDoc := ycrdt.NewDoc("alice-src", false, nil, nil, false)
	installYXmlElementPatcher(aliceDoc)
	aliceDoc.Transact(func(_ *ycrdt.Transaction) {
		frag := aliceDoc.GetXmlFragment("default").(*ycrdt.YXmlFragment)
		txt := ycrdt.NewYXmlText()
		if txt.Map == nil {
			txt.Map = make(map[string]*ycrdt.Item)
		}
		txt.Insert(0, "private-edit", nil)
		frag.Push([]any{txt})
	}, nil)
	aliceUpdate := ycrdt.EncodeStateAsUpdate(aliceDoc, nil)

	broker.RouteFrameForTest(roomKindText, itemID, aliceConn, buildDocUpdateFrame(aliceUpdate))

	time.Sleep(200 * time.Millisecond)

	serverDoc := runtime.docFor(itemID)
	if serverDoc == nil {
		t.Fatalf("runtime has no server doc for %q after routing frame", itemID)
	}
	arr := serverDoc.GetArray("editEvents")
	if arr == nil {
		t.Fatalf("editEvents root missing from server doc")
	}
	if arr.Length != 0 {
		t.Fatalf("editEvents length = %d with writer + read-only viewer; want 0 by audience-gate design", arr.Length)
	}
}
