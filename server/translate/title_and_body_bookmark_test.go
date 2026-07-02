package translate

import (
	"encoding/json"
	"testing"
)

// TestTitleStyleLevel is a tiny unit test for the title/subtitle → heading
// level map. Locks in Title→1, Subtitle→2 (case/space-insensitive) and 0
// for anything else so the set can't silently widen.
func TestTitleStyleLevel(t *testing.T) {
	cases := map[string]int{
		"Title":     1,
		"title":     1,
		"Subtitle":  2,
		"Sub Title": 2,
		"subtitle":  2,
		"":          0,
		"Normal":    0,
		"Heading1":  0,
	}
	for style, want := range cases {
		if got := titleStyleLevel(style); got != want {
			t.Errorf("titleStyleLevel(%q) = %d, want %d", style, got, want)
		}
	}
}

// TestTitleSubtitleMapToHeadings verifies that Word's document Title and
// Subtitle paragraph styles import as level-1/level-2 headings (rather than
// warning + flattening to a plain paragraph).
func TestTitleSubtitleMapToHeadings(t *testing.T) {
	cases := []struct {
		pStyle    string
		wantLevel float64
	}{
		{"Title", 1},
		{"Subtitle", 2},
	}
	for _, tc := range cases {
		t.Run(tc.pStyle, func(t *testing.T) {
			docxBytes := mustBuildMinimalDocxWithStyledParagraph(t, tc.pStyle, "Hello")
			pmJSON, warnings, err := DocxToPMJSON(docxBytes)
			if err != nil {
				t.Fatalf("DocxToPMJSON: %v", err)
			}
			if len(warnings) > 0 {
				t.Errorf("unexpected warnings for %q style: %+v", tc.pStyle, warnings)
			}
			var root PMNode
			if err := json.Unmarshal(pmJSON, &root); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if len(root.Content) != 1 {
				t.Fatalf("expected 1 top-level node, got %d", len(root.Content))
			}
			node := root.Content[0]
			if node.Type != NodeTypeHeading {
				t.Fatalf("expected heading node, got %q", node.Type)
			}
			if lvl, _ := node.Attrs["level"].(float64); lvl != tc.wantLevel {
				t.Errorf("expected heading level %v, got %v", tc.wantLevel, node.Attrs["level"])
			}
		})
	}
}

// TestBodyLevelBookmarkNoWarning verifies that bookmark/marker elements Word
// emits directly under <w:body> (document-spanning bookmarks) are skipped
// silently rather than surfacing an unsupported-node warning.
func TestBodyLevelBookmarkNoWarning(t *testing.T) {
	body := `<w:bookmarkStart w:id="0" w:name="doc"/>` +
		`<w:p><w:r><w:t>Body text</w:t></w:r></w:p>` +
		`<w:bookmarkEnd w:id="0"/>`
	pmJSON, warnings, err := DocxToPMJSON(mustBuildDocxFromBody(t, body))
	if err != nil {
		t.Fatalf("DocxToPMJSON: %v", err)
	}
	if len(warnings) > 0 {
		t.Errorf("unexpected warnings for body-level bookmarks: %+v", warnings)
	}
	var root PMNode
	if err := json.Unmarshal(pmJSON, &root); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(root.Content) != 1 || root.Content[0].Type != NodeTypeParagraph {
		t.Fatalf("expected a single paragraph, got %+v", root.Content)
	}
}
