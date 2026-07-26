package text

import (
	"sort"
	"strconv"
	"testing"

	ycrdt "github.com/skyterra/y-crdt"
)

// TestComputeMetadata_EmptyDoc verifies a doc with no clientAuthors and
// no suggestions yields a metadata struct with zero suggestionsOpen, an
// empty (but non-nil) Authors slice, and SchemaVersion = 1. The non-nil
// slice matters because callers JSON-marshal the struct; a nil slice
// would surface as `null` and break the symmetric client decoder.
func TestComputeMetadata_EmptyDoc(t *testing.T) {
	doc := ycrdt.NewDoc("meta-empty", false, nil, nil, false)
	installYXmlElementPatcher(doc)

	got := computeMetadata(doc)
	if got.SuggestionsOpen != 0 {
		t.Errorf("SuggestionsOpen = %d, want 0", got.SuggestionsOpen)
	}
	if got.Authors == nil {
		t.Errorf("Authors is nil; expected non-nil empty slice")
	}
	if len(got.Authors) != 0 {
		t.Errorf("Authors = %v, want []", got.Authors)
	}
	if got.SchemaVersion != 1 {
		t.Errorf("SchemaVersion = %d, want 1", got.SchemaVersion)
	}
}

// TestComputeMetadata_CountsOnlyOpenSuggestions seeds three suggestions
// (two open, one accepted) and verifies only the open count is
// surfaced. Mirrors the design contract: the badge counts pending work,
// not historical activity.
func TestComputeMetadata_CountsOnlyOpenSuggestions(t *testing.T) {
	doc := ycrdt.NewDoc("meta-suggestions", false, nil, nil, false)
	installYXmlElementPatcher(doc)

	sm, ok := doc.GetMap("suggestions").(*ycrdt.YMap)
	if !ok {
		t.Fatalf("suggestions root missing")
	}
	sm.Set("s1", map[string]any{
		"id":     "s1",
		"status": "open",
	})
	sm.Set("s2", map[string]any{
		"id":     "s2",
		"status": "open",
	})
	sm.Set("s3", map[string]any{
		"id":     "s3",
		"status": "accepted",
	})

	got := computeMetadata(doc)
	if got.SuggestionsOpen != 2 {
		t.Errorf("SuggestionsOpen = %d, want 2", got.SuggestionsOpen)
	}
}

// TestComputeMetadata_AuthorsFromDistinctClients seeds clientAuthors
// with three different clientIDs each mapped to a different userOrgID
// and verifies all three surface in Authors.
func TestComputeMetadata_AuthorsFromDistinctClients(t *testing.T) {
	doc := ycrdt.NewDoc("meta-authors-distinct", false, nil, nil, false)
	installYXmlElementPatcher(doc)

	authors, ok := doc.GetMap("clientAuthors").(*ycrdt.YMap)
	if !ok {
		t.Fatalf("clientAuthors root missing")
	}
	authors.Set(strconv.FormatUint(100, 10), "uo-A")
	authors.Set(strconv.FormatUint(200, 10), "uo-B")
	authors.Set(strconv.FormatUint(300, 10), "uo-C")

	got := computeMetadata(doc)
	if len(got.Authors) != 3 {
		t.Fatalf("Authors = %v (len %d), want 3 entries", got.Authors, len(got.Authors))
	}
	sort.Strings(got.Authors)
	want := []string{"uo-A", "uo-B", "uo-C"}
	for i, w := range want {
		if got.Authors[i] != w {
			t.Errorf("Authors[%d] = %q, want %q", i, got.Authors[i], w)
		}
	}
}

// TestComputeMetadata_AuthorsDeduplicateAcrossClientIDs covers the
// common case where one user has edited from multiple devices/sessions
// — each device gets its own Yjs clientID but maps back to the same
// user_org. The badge should count unique humans, not unique clientIDs.
func TestComputeMetadata_AuthorsDeduplicateAcrossClientIDs(t *testing.T) {
	doc := ycrdt.NewDoc("meta-authors-dedup", false, nil, nil, false)
	installYXmlElementPatcher(doc)

	authors, ok := doc.GetMap("clientAuthors").(*ycrdt.YMap)
	if !ok {
		t.Fatalf("clientAuthors root missing")
	}
	// Same user_org mapped from three distinct clientIDs.
	authors.Set("100", "uo-A")
	authors.Set("200", "uo-A")
	authors.Set("300", "uo-A")
	// And a separate user_org once.
	authors.Set("400", "uo-B")

	got := computeMetadata(doc)
	if len(got.Authors) != 2 {
		t.Fatalf("Authors = %v (len %d), want 2 unique entries (uo-A, uo-B)",
			got.Authors, len(got.Authors))
	}
	sort.Strings(got.Authors)
	if got.Authors[0] != "uo-A" || got.Authors[1] != "uo-B" {
		t.Errorf("Authors = %v, want [uo-A uo-B]", got.Authors)
	}
}

// TestApplyVersionRestore_DeltaApplicableToFreshPeer is the round-trip
// proof: encode state from one doc, apply to a separate live handle,
// verify the returned delta replays the source's contents into a third
// peer that started empty. Covers the broadcast contract — what we
// return is what a never-saw-it client needs to converge.
func TestApplyVersionRestore_DeltaApplicableToFreshPeer(t *testing.T) {
	source := ycrdt.NewDoc("apply-source", false, nil, nil, false)
	installYXmlElementPatcher(source)
	srcAuthors, _ := source.GetMap("clientAuthors").(*ycrdt.YMap)
	srcAuthors.Set("100", "uo-A")
	srcAuthors.Set("200", "uo-B")
	srcSuggestions, _ := source.GetMap("suggestions").(*ycrdt.YMap)
	srcSuggestions.Set("s1", map[string]any{
		"id":     "s1",
		"status": "open",
	})
	stateBytes := ycrdt.EncodeStateAsUpdate(source, nil)

	target := ycrdt.NewDoc("apply-target", false, nil, nil, false)
	installYXmlElementPatcher(target)
	handle := &textDocHandle{
		runtime:      NewRuntime(),
		id:           "apply-target",
		doc:          target,
		lastActivity: now(),
	}

	delta, err := handle.applyVersionRestore(stateBytes)
	if err != nil {
		t.Fatalf("applyVersionRestore: %v", err)
	}
	if len(delta) == 0 {
		t.Fatalf("expected non-empty delta from fresh-to-populated apply")
	}

	// Target should now mirror the source.
	tgtAuthors, _ := target.GetMap("clientAuthors").(*ycrdt.YMap)
	if v := tgtAuthors.Get("100"); v != "uo-A" {
		t.Errorf("target clientAuthors[100] = %v, want uo-A", v)
	}
	if v := tgtAuthors.Get("200"); v != "uo-B" {
		t.Errorf("target clientAuthors[200] = %v, want uo-B", v)
	}

	// Delta should fold into a third never-saw-it peer.
	peer := ycrdt.NewDoc("apply-peer", false, nil, nil, false)
	installYXmlElementPatcher(peer)
	ycrdt.ApplyUpdate(peer, delta, nil)
	peerAuthors, _ := peer.GetMap("clientAuthors").(*ycrdt.YMap)
	if v := peerAuthors.Get("100"); v != "uo-A" {
		t.Errorf("peer clientAuthors[100] = %v, want uo-A", v)
	}
	peerSuggestions, _ := peer.GetMap("suggestions").(*ycrdt.YMap)
	got := peerSuggestions.Get("s1")
	gotMap, ok := got.(map[string]any)
	if !ok {
		t.Fatalf("peer suggestions[s1] = %#v, want map", got)
	}
	if gotMap["status"] != "open" {
		t.Errorf("peer suggestions[s1].status = %v, want open", gotMap["status"])
	}
}

// TestApplyVersionRestore_OnClosedHandle verifies a closed handle
// surfaces an error rather than silently dropping the restore. The
// restore path checks handle != nil before calling this, but a race
// between the eviction janitor and the HTTP handler is possible — we
// want a clear failure mode in that window.
func TestApplyVersionRestore_OnClosedHandle(t *testing.T) {
	doc := ycrdt.NewDoc("apply-closed", false, nil, nil, false)
	installYXmlElementPatcher(doc)
	handle := &textDocHandle{
		runtime:      NewRuntime(),
		id:           "apply-closed",
		doc:          doc,
		lastActivity: now(),
		closed:       true,
	}
	_, err := handle.applyVersionRestore([]byte{0x00, 0x00})
	if err == nil {
		t.Fatalf("expected error on closed handle, got nil")
	}
}
