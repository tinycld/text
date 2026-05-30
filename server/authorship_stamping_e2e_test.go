package text

import (
	"strconv"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	ycrdt "github.com/skyterra/y-crdt"

	"tinycld.org/core/realtime"
)

// TestAuthorshipStamping_EndToEnd_TwoUsers exercises the full Phase 3a
// authorship-stamping flow through the real broker route() pipeline:
// two simulated peers with distinct Yjs clientIDs both write to the same
// room, and after both writes the server-side Y.Doc's `clientAuthors` and
// `clientFirstSeen` maps must contain entries for each peer's clientID
// keyed to its user_org record id.
//
// This is the integration smoke for the stamper as wired into the broker
// — distinct from authorship_writer_test.go (which tests the writer in
// isolation), authorship_probe_test.go (which tests clientID extraction),
// and user_org_resolver_test.go (which tests the DB lookup). All those
// units are stitched together here by routing real MsgDocUpdate frames
// through Broker.route() with the same RoomKindOptions text.Register
// would build, so a refactor that breaks any link in the chain
// (validator → probe → resolver → writer → broadcast) fails this test.
//
// We replicate text.Register's wiring locally rather than calling
// Register because Register takes *pocketbase.PocketBase but the test
// harness exposes *tests.TestApp; constructing the RoomKindOptions by
// hand mirrors the pattern in TestRealtimeWAL_Phase1_EditorWritesOK_-
// ClientAuthorshipBlocked. The wiring fields below are the same values
// Register sets (cross-reference register.go).
func TestAuthorshipStamping_EndToEnd_TwoUsers(t *testing.T) {
	t.Cleanup(realtime.ResetRegistryForTest)

	app := setupAuthTestApp(t)

	// Seed two users in the same org, both with user_org rows pointing at
	// the same drive_item. The stamper writes user_org.id (not user.id) into
	// clientAuthors, so we capture those IDs to assert on.
	alice := seedAuthorshipFixture(t, app, "alice@e2e.test", "org-1", "doc.docx")
	itemID := alice.itemID
	bob := mustCreateUser(t, app, "bob@e2e.test")
	bobUO := seedUserOrg(t, app, bob.Id, alice.orgID)

	runtime := NewRuntime()
	t.Cleanup(runtime.Stop)

	// Mirror text.Register's RegisterRoomKindWith: RuntimeProvider so the
	// broker mints a serverDoc; OnRoomCreate so the runtime gets the *Room
	// pointer (the stamper calls runtime.RoomFor → room.PublishDocUpdate);
	// OnDocUpdateContent wired to the stamper under test; permissive
	// WritePredicate so the test client is admitted. No Journal — the
	// stamper's PublishDocUpdate handles nil Journal gracefully (Room
	// only journals when opts.Journal != nil), keeping the test focused
	// on the stamping invariants rather than journal plumbing.
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

	// Build two source docs with distinct, deterministic clientIDs. y-crdt
	// auto-generates a clientID on NewDoc; we capture them after creation
	// and assert against the values stamped into clientAuthors.
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

	// Route both updates through the real broker pipeline. Each call drives
	// the entire route() → ApplyUpdate → OnDocUpdateContent path, which is
	// where the stamper observes the writing clientIDs and stamps
	// clientAuthors / clientFirstSeen via Room.PublishDocUpdate.
	broker.RouteFrameForTest(roomKindText, itemID, aliceConn, buildDocUpdateFrame(aliceUpdate))
	broker.RouteFrameForTest(roomKindText, itemID, bobConn, buildDocUpdateFrame(bobUpdate))

	// Inspect the server-side Y.Doc: clientAuthors and clientFirstSeen
	// must each have two entries, mapped to the right user_org IDs.
	serverDoc := runtime.docFor(itemID)
	if serverDoc == nil {
		t.Fatalf("runtime has no server doc for %q after routing two frames", itemID)
	}
	authors, _ := serverDoc.GetMap("clientAuthors").(*ycrdt.YMap)
	firstSeen, _ := serverDoc.GetMap("clientFirstSeen").(*ycrdt.YMap)
	if authors == nil || firstSeen == nil {
		t.Fatalf("clientAuthors / clientFirstSeen missing on server doc; stamper never wrote")
	}

	aliceKey := strconv.FormatUint(uint64(aliceClientID), 10)
	bobKey := strconv.FormatUint(uint64(bobClientID), 10)

	if got := authors.Get(aliceKey); got != alice.userOrgID {
		t.Errorf("clientAuthors[%s] (alice) = %v, want %q", aliceKey, got, alice.userOrgID)
	}
	if got := authors.Get(bobKey); got != bobUO {
		t.Errorf("clientAuthors[%s] (bob) = %v, want %q", bobKey, got, bobUO)
	}
	if firstSeen.Get(aliceKey) == nil {
		t.Errorf("clientFirstSeen[%s] (alice) is nil", aliceKey)
	}
	if firstSeen.Get(bobKey) == nil {
		t.Errorf("clientFirstSeen[%s] (bob) is nil", bobKey)
	}
}

// TestAuthorshipStamping_IdempotentOnSecondFrame verifies the cache
// short-circuit: once a clientID is stamped, a subsequent frame from the
// same clientID must NOT re-write clientAuthors / clientFirstSeen. The
// stamper consults authorshipCache.alreadyStamped before doing any work,
// so the second frame should be a no-op on the doc.
//
// Asserting on map entry counts is the strongest check: an idempotent
// stamper leaves Entries() the same length; a buggy re-stamp would
// either grow the map (different key) or churn the existing entry's
// value (which would also show up as a doc-state delta).
func TestAuthorshipStamping_IdempotentOnSecondFrame(t *testing.T) {
	t.Cleanup(realtime.ResetRegistryForTest)

	app := setupAuthTestApp(t)
	alice := seedAuthorshipFixture(t, app, "alice@e2e.test", "org-1", "doc.docx")
	itemID := alice.itemID

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
	conn := realtime.NewClientForTest(alice.userID)

	// Single source doc — both frames are encoded from the same Y.Doc, so
	// both carry the same clientID. The first frame writes "v1", the second
	// extends with "v2"; both encode as MsgDocUpdate payloads the broker
	// routes through the same stamper.
	src := ycrdt.NewDoc("alice-src", false, nil, nil, false)
	installYXmlElementPatcher(src)
	src.Transact(func(_ *ycrdt.Transaction) {
		frag := src.GetXmlFragment("default").(*ycrdt.YXmlFragment)
		txt := ycrdt.NewYXmlText()
		if txt.Map == nil {
			txt.Map = make(map[string]*ycrdt.Item)
		}
		txt.Insert(0, "v1", nil)
		frag.Push([]any{txt})
	}, nil)
	update1 := ycrdt.EncodeStateAsUpdate(src, nil)

	broker.RouteFrameForTest(roomKindText, itemID, conn, buildDocUpdateFrame(update1))

	// Snapshot the maps after the first stamp.
	serverDoc := runtime.docFor(itemID)
	if serverDoc == nil {
		t.Fatalf("runtime has no server doc for %q after first frame", itemID)
	}
	authors, _ := serverDoc.GetMap("clientAuthors").(*ycrdt.YMap)
	firstSeen, _ := serverDoc.GetMap("clientFirstSeen").(*ycrdt.YMap)
	if authors == nil || firstSeen == nil {
		t.Fatalf("first frame did not populate authorship maps")
	}
	beforeAuthors := len(authors.Entries())
	beforeFirstSeen := len(firstSeen.Entries())
	if beforeAuthors == 0 {
		t.Fatalf("first frame produced zero clientAuthors entries; test premise broken")
	}
	cidKey := strconv.FormatUint(uint64(uint32(src.ClientID)), 10)
	beforeFirstSeenVal := firstSeen.Get(cidKey)

	// Second frame: same source doc, additional mutation → same clientID.
	// Writes to a fresh YText root so the encoded delta carries a new item
	// but the writing clientID is unchanged from the first frame. The
	// stamper's cache must short-circuit on the clientID match regardless
	// of which root the new write touches.
	src.Transact(func(_ *ycrdt.Transaction) {
		src.GetText("scratch").Insert(0, "v2", nil)
	}, nil)
	update2 := ycrdt.EncodeStateAsUpdate(src, nil)
	broker.RouteFrameForTest(roomKindText, itemID, conn, buildDocUpdateFrame(update2))

	afterAuthors := len(authors.Entries())
	afterFirstSeen := len(firstSeen.Entries())
	if afterAuthors != beforeAuthors {
		t.Errorf("second frame from same clientID added %d entries to clientAuthors; want 0",
			afterAuthors-beforeAuthors)
	}
	if afterFirstSeen != beforeFirstSeen {
		t.Errorf("second frame from same clientID added %d entries to clientFirstSeen; want 0",
			afterFirstSeen-beforeFirstSeen)
	}
	// Re-stamping would also overwrite the existing firstSeen value; pin
	// that the original timestamp survives.
	if got := firstSeen.Get(cidKey); got != beforeFirstSeenVal {
		t.Errorf("second frame re-wrote clientFirstSeen[%s]: was %v, now %v",
			cidKey, beforeFirstSeenVal, got)
	}
}
