package text

import (
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	ycrdt "github.com/skyterra/y-crdt"

	"tinycld.org/core/realtime"
)

// TestEditEvents_SingleClient_EmitsOneEventAfterWindow exercises the
// Phase 3b emission path end-to-end through the broker: two inbound Yjs
// frames from the SAME clientID land within a shortened debounce window,
// the per-room editEventBuffer holds them in a single window, the timer
// fires after WindowDuration, and the flush callback writes one
// EditEvent into the server doc's editEvents Y.Array.
//
// The test mirrors authorship_stamping_e2e_test.go's broker-driven
// pattern (Phase 3a Task 11): real Broker.RouteFrameForTest, real
// stamper, real publishEditEvent + writeEditEvent. Only the
// WindowDuration is shortened — to 50ms — so the test completes in
// well under a second instead of waiting a real 60s window.
//
// The "two frames" choice (rather than one) verifies the buffer's
// extend-the-window branch: the second Note bumps editCount from 1 to
// 2 and resets the timer. The resulting EditEvent should carry
// editCount=2, proving the window aggregated rather than emitting
// twice.
func TestEditEvents_SingleClient_EmitsOneEventAfterWindow(t *testing.T) {
	t.Cleanup(realtime.ResetRegistryForTest)

	// Shorten the debounce window so the test completes in ~200ms
	// instead of the production 60s. Restored on cleanup so other
	// tests that run after this one see the original value.
	origWindow := WindowDuration
	WindowDuration = 50 * time.Millisecond
	t.Cleanup(func() { WindowDuration = origWindow })

	app := setupAuthTestApp(t)
	alice := seedAuthorshipFixture(t, app, "alice@e2e.test", "org-1", "doc.docx")
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
		OnDocUpdateContent: makeAuthorshipStamper(app, runtime),
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
	if arr.Length != 1 {
		t.Fatalf("editEvents length = %d after single-client window, want 1", arr.Length)
	}

	raw := arr.Get(0)
	entry, ok := raw.(map[string]interface{})
	if !ok {
		t.Fatalf("editEvents[0] is not a map: %T", raw)
	}

	if cid, _ := entry["clientId"].(int); uint32(cid) != aliceClientID {
		t.Errorf("editEvents[0].clientId = %v, want %d", entry["clientId"], aliceClientID)
	}
	if got := entry["authorId"]; got != alice.userOrgID {
		t.Errorf("editEvents[0].authorId = %v, want %q", got, alice.userOrgID)
	}
	if got, _ := entry["editCount"].(int); got != 2 {
		t.Errorf("editEvents[0].editCount = %v, want 2 (two frames in window)", entry["editCount"])
	}
	// affectedNodes is set to []interface{}{} by the writer when the
	// buffer passes nil (Task 6). The Y.Array round-trip preserves the
	// type as []interface{} (possibly with zero length).
	nodes, ok := entry["affectedNodes"].([]interface{})
	if !ok {
		t.Errorf("editEvents[0].affectedNodes = %T, want []interface{}", entry["affectedNodes"])
	} else if len(nodes) != 0 {
		t.Errorf("editEvents[0].affectedNodes len = %d, want 0 (stamper passes nil)", len(nodes))
	}
}

// TestEditEvents_TwoClients_EmitsSeparateEvents drives one frame each
// from two distinct clientIDs. The buffer arms a separate timer per
// clientID, so both windows close independently within the shortened
// WindowDuration. The flush callback runs on each timer's goroutine;
// both writes go through handle.publishEditEvent, which serializes
// through the handle mutex, so the two YArray pushes don't corrupt
// each other. After the window closes, editEvents should contain
// exactly two entries, one per clientID, each mapped to the right
// authorID.
//
// The strongest check is that BOTH entries surface — a missed flush
// (e.g. timer cleared by a concurrent reset) would show up as a
// length-1 array. The clientID → authorID mapping check confirms the
// buffer didn't cross-pollinate windows between clients.
func TestEditEvents_TwoClients_EmitsSeparateEvents(t *testing.T) {
	t.Cleanup(realtime.ResetRegistryForTest)

	origWindow := WindowDuration
	WindowDuration = 50 * time.Millisecond
	t.Cleanup(func() { WindowDuration = origWindow })

	app := setupAuthTestApp(t)
	alice := seedAuthorshipFixture(t, app, "alice@e2e.test", "org-1", "doc.docx")
	itemID := alice.itemID
	bob := mustCreateUser(t, app, "bob@e2e.test")
	bobUO := seedUserOrg(t, app, bob.Id, alice.orgID)

	runtime := NewRuntime()
	t.Cleanup(runtime.Stop)

	realtime.RegisterRoomKindWith(roomKindText, realtime.RoomKindOptions{
		Authorize:       func(_ *core.Record, _ string) error { return nil },
		RuntimeProvider: runtime,
		OnRoomCreate: func(_ string, _ realtime.DocHandle, room *realtime.Room) {
			runtime.noteRoom(itemID, room)
		},
		OnDocUpdateContent: makeAuthorshipStamper(app, runtime),
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

	broker.RouteFrameForTest(roomKindText, itemID, aliceConn, buildDocUpdateFrame(aliceUpdate))
	broker.RouteFrameForTest(roomKindText, itemID, bobConn, buildDocUpdateFrame(bobUpdate))

	// Both per-clientID timers fire within this window; both flush
	// callbacks serialize through handle.mu so the YArray ends with
	// both entries intact.
	time.Sleep(200 * time.Millisecond)

	serverDoc := runtime.docFor(itemID)
	if serverDoc == nil {
		t.Fatalf("runtime has no server doc for %q after routing frames", itemID)
	}
	arr := serverDoc.GetArray("editEvents")
	if arr == nil {
		t.Fatalf("editEvents root missing from server doc")
	}
	if arr.Length != 2 {
		t.Fatalf("editEvents length = %d after two-client windows, want 2", arr.Length)
	}

	// Build a clientID → authorID map from the array entries to
	// assert without depending on emission order (the two flush
	// goroutines race, so ordering between alice and bob isn't fixed).
	got := map[uint32]string{}
	for i := 0; i < arr.Length; i++ {
		raw := arr.Get(i)
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
	} else if author != alice.userOrgID {
		t.Errorf("editEvents[alice].authorId = %q, want %q", author, alice.userOrgID)
	}
	if author, ok := got[bobClientID]; !ok {
		t.Errorf("editEvents missing entry for bob clientID %d (got %v)", bobClientID, got)
	} else if author != bobUO {
		t.Errorf("editEvents[bob].authorId = %q, want %q", author, bobUO)
	}
}
