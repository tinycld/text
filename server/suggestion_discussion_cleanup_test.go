package text

import (
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	ycrdt "github.com/skyterra/y-crdt"
)

// setupDiscussionCleanupTestApp builds the minimum collection graph the
// archive pass touches: drive_items (so text_comments can satisfy its
// relation) and text_comments itself, including the suggestion_id and
// archived_at fields added in Phase 5 Task 1. Mirrors the pattern in
// fixtures_test.go::setupTestApp + comment_mentions_test.go.
//
// The author relation on text_comments expects user_org in production;
// here we stand it up as a TextField so the test doesn't have to seed
// the full user_org chain just to satisfy schema validation.
func setupDiscussionCleanupTestApp(t *testing.T) *tests.TestApp {
	t.Helper()
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("NewTestApp: %v", err)
	}
	t.Cleanup(func() { app.Cleanup() })

	driveItems := core.NewBaseCollection("drive_items")
	driveItems.Fields.Add(&core.TextField{Name: "name"})
	driveItems.Fields.Add(&core.TextField{Name: "org"})
	if err := app.Save(driveItems); err != nil {
		t.Fatalf("save drive_items: %v", err)
	}

	textComments := core.NewBaseCollection("text_comments")
	textComments.Fields.Add(&core.RelationField{
		Name: "drive_item", Required: true, CollectionId: driveItems.Id, MaxSelect: 1,
	})
	textComments.Fields.Add(&core.TextField{Name: "comment_id"})
	textComments.Fields.Add(&core.TextField{Name: "suggestion_id"})
	textComments.Fields.Add(&core.TextField{Name: "body", Required: true})
	textComments.Fields.Add(&core.DateField{Name: "archived_at"})
	textComments.Fields.Add(&core.TextField{Name: "author"})
	textComments.Fields.Add(&core.TextField{Name: "author_name"})
	if err := app.Save(textComments); err != nil {
		t.Fatalf("save text_comments: %v", err)
	}

	return app
}

// seedDiscussionReply creates a text_comments row tied to the given
// suggestion id. Mirrors the production adapter shape: suggestion_id set,
// comment_id null, archived_at null. Returns the saved record so the
// caller can re-read it after the archive pass to assert on archived_at.
func seedDiscussionReply(
	t *testing.T,
	app *tests.TestApp,
	driveItemID, suggestionID, body string,
) *core.Record {
	t.Helper()
	col, err := app.FindCollectionByNameOrId("text_comments")
	if err != nil {
		t.Fatalf("find text_comments: %v", err)
	}
	rec := core.NewRecord(col)
	rec.Set("drive_item", driveItemID)
	rec.Set("suggestion_id", suggestionID)
	rec.Set("body", body)
	rec.Set("author", "uo-stub")
	rec.Set("author_name", "Test")
	if err := app.Save(rec); err != nil {
		t.Fatalf("save text_comments: %v", err)
	}
	return rec
}

// newDocWithSuggestions returns a fresh server-style Y.Doc with the
// given suggestion ids written into its `suggestions` Y.Map. Mirrors
// how seedSuggestionsMap writes entries in bootstrap.go but reduced to
// just the id key — diffSuggestionKeys only reads keys, not full
// entries, so a minimal stub value per key is sufficient.
func newDocWithSuggestions(t *testing.T, ids ...string) *ycrdt.Doc {
	t.Helper()
	doc := ycrdt.NewDoc("test-room", false, nil, nil, false)
	installYXmlElementPatcher(doc)
	m, ok := doc.GetMap("suggestions").(*ycrdt.YMap)
	if !ok {
		t.Fatalf("doc.GetMap returned non-YMap")
	}
	for _, id := range ids {
		m.Set(id, map[string]any{"id": id, "status": "open"})
	}
	return doc
}

// TestReadSuggestionKeySet verifies the key-extraction helper returns
// the exact set of ids written into the suggestions Y.Map. The diff
// path's correctness rests entirely on this returning the truth about
// what's currently in the doc — a buggy reader would shadow legitimate
// suggestions as "deleted" or hide actual deletions.
func TestReadSuggestionKeySet(t *testing.T) {
	doc := newDocWithSuggestions(t, "s1", "s2", "s3")

	keys := readSuggestionKeySet(doc)
	if len(keys) != 3 {
		t.Errorf("readSuggestionKeySet returned %d keys, want 3", len(keys))
	}
	for _, want := range []string{"s1", "s2", "s3"} {
		if _, ok := keys[want]; !ok {
			t.Errorf("readSuggestionKeySet missing key %q", want)
		}
	}
}

// TestReadSuggestionKeySetEmpty handles the freshly-bootstrapped doc
// case: no suggestions written yet, GetMap auto-creates the root, and
// the helper must return an empty (non-nil) set so the diff path
// doesn't blow up on a nil-map lookup.
func TestReadSuggestionKeySetEmpty(t *testing.T) {
	doc := ycrdt.NewDoc("empty", false, nil, nil, false)
	installYXmlElementPatcher(doc)

	keys := readSuggestionKeySet(doc)
	if keys == nil {
		t.Fatalf("readSuggestionKeySet returned nil for empty doc; want empty map")
	}
	if len(keys) != 0 {
		t.Errorf("readSuggestionKeySet on empty doc returned %d keys, want 0", len(keys))
	}
}

// TestReadSuggestionKeySetNilDoc guards against a nil doc passed in by
// a caller racing with closeDoc. The cleanup callback already checks
// docFor != nil before calling diff, but defense-in-depth here means a
// future refactor can't silently introduce a nil-deref panic on the
// route goroutine.
func TestReadSuggestionKeySetNilDoc(t *testing.T) {
	keys := readSuggestionKeySet(nil)
	if keys == nil {
		t.Fatalf("readSuggestionKeySet(nil) returned nil; want empty map")
	}
	if len(keys) != 0 {
		t.Errorf("readSuggestionKeySet(nil) returned %d keys, want 0", len(keys))
	}
}

// TestDiffSuggestionKeysFirstCall covers the bootstrap case: no prior
// snapshot exists for the room, so the diff must report zero deletions
// even if the doc carries entries. The snapshot stored after this call
// becomes the baseline for the next round.
func TestDiffSuggestionKeysFirstCall(t *testing.T) {
	runtime := NewRuntime()
	t.Cleanup(runtime.Stop)
	doc := newDocWithSuggestions(t, "s1", "s2")

	deleted := runtime.diffSuggestionKeys("room-1", doc)
	if len(deleted) != 0 {
		t.Errorf("first diff returned %d deletions; want 0 (baseline only)", len(deleted))
	}

	// Snapshot must now contain the doc's current keys so the next
	// diff has a baseline to compare against.
	runtime.mu.Lock()
	snap := runtime.prevSuggestionKeys["room-1"]
	runtime.mu.Unlock()
	if len(snap) != 2 {
		t.Errorf("snapshot after first diff has %d keys; want 2", len(snap))
	}
}

// TestDiffSuggestionKeysDeletion is the primary positive case: the
// previous snapshot has a key the current doc lacks, so the diff must
// report that key as deleted and update the snapshot to drop it.
func TestDiffSuggestionKeysDeletion(t *testing.T) {
	runtime := NewRuntime()
	t.Cleanup(runtime.Stop)

	// Seed the baseline with s1 + s2.
	docBefore := newDocWithSuggestions(t, "s1", "s2")
	_ = runtime.diffSuggestionKeys("room-1", docBefore)

	// Now the doc has only s1 — s2 was deleted between updates.
	docAfter := newDocWithSuggestions(t, "s1")
	deleted := runtime.diffSuggestionKeys("room-1", docAfter)

	if len(deleted) != 1 {
		t.Fatalf("diff reported %d deletions; want 1", len(deleted))
	}
	if deleted[0] != "s2" {
		t.Errorf("diff reported deleted=%q; want %q", deleted[0], "s2")
	}

	// Snapshot must now reflect the post-state: only s1.
	runtime.mu.Lock()
	snap := runtime.prevSuggestionKeys["room-1"]
	runtime.mu.Unlock()
	if len(snap) != 1 {
		t.Errorf("snapshot after deletion has %d keys; want 1", len(snap))
	}
	if _, ok := snap["s1"]; !ok {
		t.Errorf("snapshot missing s1 after deletion of s2")
	}
}

// TestDiffSuggestionKeysAddition guards against false positives: if the
// frame ADDS a suggestion (snapshot empty, current has s1), no key was
// deleted and the diff must return nothing.
func TestDiffSuggestionKeysAddition(t *testing.T) {
	runtime := NewRuntime()
	t.Cleanup(runtime.Stop)

	// Baseline: empty.
	empty := ycrdt.NewDoc("baseline", false, nil, nil, false)
	installYXmlElementPatcher(empty)
	_ = runtime.diffSuggestionKeys("room-1", empty)

	// Frame added s1.
	docAfter := newDocWithSuggestions(t, "s1")
	deleted := runtime.diffSuggestionKeys("room-1", docAfter)

	if len(deleted) != 0 {
		t.Errorf("diff after add reported %d deletions; want 0", len(deleted))
	}
}

// TestDiffSuggestionKeysIdempotent ensures the diff doesn't double-report
// a deletion on subsequent identical reads. The first diff records the
// removal; the second diff sees an unchanged doc and must report
// nothing.
func TestDiffSuggestionKeysIdempotent(t *testing.T) {
	runtime := NewRuntime()
	t.Cleanup(runtime.Stop)

	// Baseline carries s1 + s2.
	before := newDocWithSuggestions(t, "s1", "s2")
	_ = runtime.diffSuggestionKeys("room-1", before)

	// First diff: s2 was deleted.
	after := newDocWithSuggestions(t, "s1")
	first := runtime.diffSuggestionKeys("room-1", after)
	if len(first) != 1 || first[0] != "s2" {
		t.Fatalf("first diff = %v; want [s2]", first)
	}

	// Second diff against the same post-state: nothing changed, no
	// deletions to report.
	second := runtime.diffSuggestionKeys("room-1", after)
	if len(second) != 0 {
		t.Errorf("second diff = %v; want empty (idempotent)", second)
	}
}

// TestArchiveOrphanedDiscussions stamps archived_at on every text_comments
// row whose suggestion_id matches the deleted id and leaves untouched
// rows alone. The drawer's live query filters on archived_at = null, so
// this is the visible-effect signal that the cleanup ran.
func TestArchiveOrphanedDiscussions(t *testing.T) {
	app := setupDiscussionCleanupTestApp(t)
	driveItem := seedDriveItemInOrg(t, app, "org-1", "doc.docx")

	keep := seedDiscussionReply(t, app, driveItem.Id, "s1", "live")
	archive := seedDiscussionReply(t, app, driveItem.Id, "s2", "going away")

	archiveOrphanedDiscussions(app, []string{"s2"})

	// Reload both rows. The matching row must have archived_at set; the
	// non-matching row must remain pristine.
	gotKeep, err := app.FindRecordById("text_comments", keep.Id)
	if err != nil {
		t.Fatalf("re-fetch keep row: %v", err)
	}
	if !gotKeep.GetDateTime("archived_at").IsZero() {
		t.Errorf("unrelated row %s got archived_at = %v; want zero",
			keep.Id, gotKeep.GetDateTime("archived_at"))
	}

	gotArchive, err := app.FindRecordById("text_comments", archive.Id)
	if err != nil {
		t.Fatalf("re-fetch archive row: %v", err)
	}
	if gotArchive.GetDateTime("archived_at").IsZero() {
		t.Errorf("matching row %s has zero archived_at; want non-zero", archive.Id)
	}
}

// TestArchiveOrphanedDiscussionsSkipsAlreadyArchived guards against
// re-stamping. The filter excludes rows whose archived_at is already
// set, so a second pass over the same ids must not bump the timestamp.
// Without this, the cleanup hook would churn the archived_at value on
// every doc update, breaking any historical-view UI that orders by
// archive time.
func TestArchiveOrphanedDiscussionsSkipsAlreadyArchived(t *testing.T) {
	app := setupDiscussionCleanupTestApp(t)
	driveItem := seedDriveItemInOrg(t, app, "org-1", "doc.docx")
	row := seedDiscussionReply(t, app, driveItem.Id, "s1", "thread")

	archiveOrphanedDiscussions(app, []string{"s1"})

	after1, err := app.FindRecordById("text_comments", row.Id)
	if err != nil {
		t.Fatalf("re-fetch after first archive: %v", err)
	}
	firstStamp := after1.GetDateTime("archived_at")
	if firstStamp.IsZero() {
		t.Fatalf("first archive did not stamp archived_at")
	}

	// Second pass on the same id — the filter (archived_at = null)
	// should exclude this row, leaving its stamp untouched.
	archiveOrphanedDiscussions(app, []string{"s1"})

	after2, err := app.FindRecordById("text_comments", row.Id)
	if err != nil {
		t.Fatalf("re-fetch after second archive: %v", err)
	}
	if !after2.GetDateTime("archived_at").Equal(firstStamp) {
		t.Errorf("second archive changed archived_at: was %v, now %v",
			firstStamp, after2.GetDateTime("archived_at"))
	}
}

// TestArchiveOrphanedDiscussionsEmptyIDs is the no-op guard: a call
// with no ids must not query or write anything. Cheap to assert (no
// side effect to inspect) but ensures the callback's "deleted empty,
// skip archive" short-circuit isn't accidentally bypassed by a future
// refactor.
func TestArchiveOrphanedDiscussionsEmptyIDs(t *testing.T) {
	app := setupDiscussionCleanupTestApp(t)
	driveItem := seedDriveItemInOrg(t, app, "org-1", "doc.docx")
	row := seedDiscussionReply(t, app, driveItem.Id, "s1", "thread")

	archiveOrphanedDiscussions(app, nil)
	archiveOrphanedDiscussions(app, []string{})

	got, err := app.FindRecordById("text_comments", row.Id)
	if err != nil {
		t.Fatalf("re-fetch row: %v", err)
	}
	if !got.GetDateTime("archived_at").IsZero() {
		t.Errorf("empty archive call stamped archived_at; want zero")
	}
}

// TestInitSuggestionKeySnapshotSeedsBaseline verifies that noteRoom's
// snapshot priming gives the first OnDocUpdateContent invocation a
// baseline to diff against — without this, a delete in the first
// inbound frame would slip through as "no prior snapshot, skip".
func TestInitSuggestionKeySnapshotSeedsBaseline(t *testing.T) {
	runtime := NewRuntime()
	t.Cleanup(runtime.Stop)

	doc := newDocWithSuggestions(t, "s1", "s2")
	runtime.initSuggestionKeySnapshot("room-1", doc)

	// Now diff against a doc that has dropped s2 — the seeded baseline
	// must let us catch this as a deletion, not a "first observation".
	docAfter := newDocWithSuggestions(t, "s1")
	deleted := runtime.diffSuggestionKeys("room-1", docAfter)
	if len(deleted) != 1 || deleted[0] != "s2" {
		t.Errorf("diff after seeded baseline = %v; want [s2]", deleted)
	}
}

// TestCloseDocDropsSuggestionSnapshot verifies the per-room teardown
// removes the snapshot so a long-running server doesn't accumulate
// stale entries for evicted rooms. Mirrors the cleanup pattern for
// authorship cache + edit buffers.
func TestCloseDocDropsSuggestionSnapshot(t *testing.T) {
	runtime := NewRuntime()
	t.Cleanup(runtime.Stop)

	// Stand up a real doc on the runtime via NewDoc so closeDoc has
	// something to tear down. NewDoc registers in the docs map; closeDoc
	// needs the entry to exist or it returns false.
	if _, err := runtime.NewDoc("room-1"); err != nil {
		t.Fatalf("NewDoc: %v", err)
	}
	doc := runtime.docFor("room-1")
	if doc == nil {
		t.Fatalf("doc not registered after NewDoc")
	}
	runtime.initSuggestionKeySnapshot("room-1", doc)

	runtime.mu.Lock()
	_, present := runtime.prevSuggestionKeys["room-1"]
	runtime.mu.Unlock()
	if !present {
		t.Fatalf("snapshot entry missing after init")
	}

	if !runtime.closeDoc("room-1") {
		t.Fatalf("closeDoc returned false; expected true")
	}

	runtime.mu.Lock()
	_, stillPresent := runtime.prevSuggestionKeys["room-1"]
	runtime.mu.Unlock()
	if stillPresent {
		t.Errorf("snapshot entry survived closeDoc; want dropped")
	}
}

// TestPayloadTouchesSuggestionsRoot pins the fast-path probe used by
// the cleanup hook to skip docFor + diffSuggestionKeys when an inbound
// MsgDocUpdate doesn't write to the `suggestions` Y.Map. This is the
// per-frame perf gate flagged by the PR review: without it the server
// pays an O(suggestions-count) Y.Map walk + r.mu acquisition for every
// keystroke even though most updates touch only the `prosemirror` xml
// fragment.
func TestPayloadTouchesSuggestionsRoot(t *testing.T) {
	// Build a synthetic payload that writes ONLY to the prosemirror
	// xml fragment — the shape every text-keystroke update has.
	docA := ycrdt.NewDoc("a", false, nil, nil, false)
	docA.GetXmlFragment("prosemirror")
	// Touch the fragment so the encoded update actually carries a
	// write rooted at "prosemirror".
	if frag, ok := docA.GetXmlFragment("prosemirror").(*ycrdt.YXmlFragment); ok {
		t := ycrdt.NewYXmlText()
		frag.Push([]any{t})
	}
	updateA := ycrdt.EncodeStateAsUpdate(docA, nil)
	if payloadTouchesSuggestionsRoot("probe", updateA) {
		t.Errorf("prosemirror-only update should not touch suggestions root")
	}

	// Build a second payload that writes to the suggestions Y.Map.
	docB := ycrdt.NewDoc("b", false, nil, nil, false)
	suggMap, ok := docB.GetMap("suggestions").(*ycrdt.YMap)
	if !ok {
		t.Fatalf("GetMap('suggestions') did not return *YMap")
	}
	suggMap.Set("s_test", "value")
	updateB := ycrdt.EncodeStateAsUpdate(docB, nil)
	if !payloadTouchesSuggestionsRoot("probe", updateB) {
		t.Errorf("suggestions-Y.Map write should be detected")
	}
}
