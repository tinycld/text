package text

import (
	"sort"
	"strconv"
	"testing"

	ycrdt "github.com/skyterra/y-crdt"
)

// Tests in this file cover the Task 4 surface: computeMetadata's
// suggestion counting and clientAuthors deduplication. The
// applyVersionRestore round-trip lives in Task 5.

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

