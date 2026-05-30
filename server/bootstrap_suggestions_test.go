package text

import (
	"testing"

	ycrdt "github.com/skyterra/y-crdt"

	"tinycld.org/packages/text/translate"
)

// TestBootstrapPopulatesSuggestionsMapFromDocx seeds the runtime with
// a docx carrying a suggestion mark + entry, drives the bootstrap to
// build a Y.Doc, then reads the resulting `suggestions` Y.Map and
// confirms the entry made it through. Exercises the full path:
// translate.DocxToPMJSONWithSuggestions → bootstrap → seedSuggestionsMap
// → readSuggestionsMap (which the flush path also uses).
func TestBootstrapPopulatesSuggestionsMapFromDocx(t *testing.T) {
	pmJSON := []byte(`{
		"type": "doc",
		"content": [{
			"type": "paragraph",
			"content": [{
				"type": "text",
				"text": "proposed",
				"marks": [{
					"type": "suggestedInsert",
					"attrs": {"suggestionId": "s_alice", "authorId": "uo_alice", "ts": 1700000000000}
				}]
			}]
		}]
	}`)
	entries := []translate.SuggestionMapEntry{
		{
			ID:        "s_alice",
			AuthorID:  "uo_alice",
			CreatedAt: 1700000000000,
			Status:    "open",
		},
	}
	docxBytes, _, err := translate.PMJSONToDocxWithSuggestions(pmJSON, entries)
	if err != nil {
		t.Fatalf("PM→docx: %v", err)
	}

	app := setupTestApp(t)
	item := seedDriveItem(t, app, "with-suggestion.docx", docxBytes)

	runtime := NewRuntime()
	runtime.SetBootstrap(makeDocxBootstrap(app, runtime))

	handle, err := runtime.NewDoc(item.Id)
	if err != nil {
		t.Fatalf("NewDoc: %v", err)
	}
	defer func() { _ = handle.Close() }()

	// readSuggestionsMap is the same helper the flush path uses to
	// drain the Y.Map back out — exercising it here verifies the
	// bootstrap-written entries round-trip through the runtime's view
	// of the document.
	got := readSuggestionsMap(runtimeDoc(runtime, item.Id))
	if len(got) != 1 {
		t.Fatalf("readSuggestionsMap returned %d entries, want 1: %+v", len(got), got)
	}
	e := got[0]
	if e.ID != "s_alice" {
		t.Errorf("entry.ID = %q, want %q", e.ID, "s_alice")
	}
	if e.AuthorID != "uo_alice" {
		t.Errorf("entry.AuthorID = %q, want %q", e.AuthorID, "uo_alice")
	}
	if e.CreatedAt != 1700000000000 {
		t.Errorf("entry.CreatedAt = %d, want %d", e.CreatedAt, int64(1700000000000))
	}
	if e.Status != "open" {
		t.Errorf("entry.Status = %q, want %q", e.Status, "open")
	}
}

// TestBootstrapPopulatesSuggestionsMapWithResolvedEntry verifies the
// optional lifecycle fields (resolvedBy, resolvedAt, note) survive the
// docx ↔ Y.Map round trip — a resolved entry imported from docx needs
// to surface to the client with its full state so the drawer can show
// "accepted by X" / "rejected by Y" without a follow-up edit.
func TestBootstrapPopulatesSuggestionsMapWithResolvedEntry(t *testing.T) {
	pmJSON := []byte(`{
		"type": "doc",
		"content": [{
			"type": "paragraph",
			"content": [{
				"type": "text",
				"text": "doomed",
				"marks": [{
					"type": "suggestedDelete",
					"attrs": {"suggestionId": "s_bob", "authorId": "uo_bob", "ts": 1700000000000}
				}]
			}]
		}]
	}`)
	entries := []translate.SuggestionMapEntry{
		{
			ID:         "s_bob",
			AuthorID:   "uo_bob",
			CreatedAt:  1700000000000,
			Status:     "accepted",
			ResolvedBy: "uo_carol",
			ResolvedAt: 1700000100000,
			Note:       "lgtm",
		},
	}
	docxBytes, _, err := translate.PMJSONToDocxWithSuggestions(pmJSON, entries)
	if err != nil {
		t.Fatalf("PM→docx: %v", err)
	}

	app := setupTestApp(t)
	item := seedDriveItem(t, app, "resolved-suggestion.docx", docxBytes)

	runtime := NewRuntime()
	runtime.SetBootstrap(makeDocxBootstrap(app, runtime))

	handle, err := runtime.NewDoc(item.Id)
	if err != nil {
		t.Fatalf("NewDoc: %v", err)
	}
	defer func() { _ = handle.Close() }()

	got := readSuggestionsMap(runtimeDoc(runtime, item.Id))
	if len(got) != 1 {
		t.Fatalf("readSuggestionsMap returned %d entries, want 1: %+v", len(got), got)
	}
	e := got[0]
	if e.Status != "accepted" {
		t.Errorf("entry.Status = %q, want %q", e.Status, "accepted")
	}
	if e.ResolvedBy != "uo_carol" {
		t.Errorf("entry.ResolvedBy = %q, want %q", e.ResolvedBy, "uo_carol")
	}
	if e.ResolvedAt != 1700000100000 {
		t.Errorf("entry.ResolvedAt = %d, want %d", e.ResolvedAt, int64(1700000100000))
	}
	if e.Note != "lgtm" {
		t.Errorf("entry.Note = %q, want %q", e.Note, "lgtm")
	}
}

// TestBootstrapDocxWithoutSuggestionsLeavesMapEmpty confirms the
// no-customXml path: a vanilla docx (no suggestion marks, no tinycld
// custom XML) bootstraps cleanly and the suggestions Y.Map stays empty.
// Guards against an accidental write of a placeholder entry when the
// parser returns nil entries.
func TestBootstrapDocxWithoutSuggestionsLeavesMapEmpty(t *testing.T) {
	pmJSON := []byte(`{
		"type": "doc",
		"content": [{
			"type": "paragraph",
			"content": [{"type": "text", "text": "no suggestions here"}]
		}]
	}`)
	docxBytes, _, err := translate.PMJSONToDocxWithSuggestions(pmJSON, nil)
	if err != nil {
		t.Fatalf("PM→docx: %v", err)
	}

	app := setupTestApp(t)
	item := seedDriveItem(t, app, "no-suggestions.docx", docxBytes)

	runtime := NewRuntime()
	runtime.SetBootstrap(makeDocxBootstrap(app, runtime))

	handle, err := runtime.NewDoc(item.Id)
	if err != nil {
		t.Fatalf("NewDoc: %v", err)
	}
	defer func() { _ = handle.Close() }()

	got := readSuggestionsMap(runtimeDoc(runtime, item.Id))
	if len(got) != 0 {
		t.Errorf("readSuggestionsMap returned %d entries on a docx with no suggestions, want 0: %+v", len(got), got)
	}
}

// runtimeDoc fetches the registered Y.Doc for a room under the
// runtime's mutex, matching the access pattern in runtime_test.go. The
// bootstrap has already returned by the time NewDoc hands back, but
// the runtime's internal map is mutated under r.mu in production so
// the tests grab the lock too to stay race-clean under -race.
func runtimeDoc(r *Runtime, roomID string) *ycrdt.Doc {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.docs[roomID]
}

// TestSeedSuggestionsMapEmptyEntriesIsNoOp documents the unit-level
// contract: an empty entries slice should not create the Y.Map (so a
// fresh, untouched doc bootstrap doesn't leak phantom keys). We can
// only assert via the readSuggestionsMap drain since y-crdt's GetMap
// auto-creates the underlying type on first access.
func TestSeedSuggestionsMapEmptyEntriesIsNoOp(t *testing.T) {
	doc := ycrdt.NewDoc("test", false, nil, nil, false)
	seedSuggestionsMap(doc, nil)
	if got := readSuggestionsMap(doc); len(got) != 0 {
		t.Errorf("seedSuggestionsMap(nil) populated %d entries, want 0", len(got))
	}

	seedSuggestionsMap(doc, []translate.SuggestionMapEntry{})
	if got := readSuggestionsMap(doc); len(got) != 0 {
		t.Errorf("seedSuggestionsMap([]) populated %d entries, want 0", len(got))
	}
}
