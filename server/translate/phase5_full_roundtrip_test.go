package translate

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

// TestPhase5FullRoundTripAllSuggestionKinds is the spec-level success
// criterion for Phase 5: "Docx export carries suggestions to Word as
// native track-changes and round-trips back." Constructs ONE document
// carrying all five suggestion kinds, runs PM → docx → PM, then
// asserts every entry survives the round-trip in the resulting PM
// tree.
//
// Coverage:
//   - Phase 2c suggestedInsert (inline) → <w:ins>
//   - Phase 2c suggestedDelete (inline) → <w:del>
//   - Phase 5a suggestedFormatChange (run rPr) → <w:rPrChange>
//   - Phase 5b suggestedBlockChange on a paragraph → <w:pPrChange>
//   - Phase 5c suggestedBlockChange on a tableCell → <w:tcPrChange>
//
// The doc deliberately spans multiple structures (a heading, three
// body paragraphs, and a table) so a regression in one kind that
// happens to land on the wrong element type still surfaces.
func TestPhase5FullRoundTripAllSuggestionKinds(t *testing.T) {
	pmJSON := []byte(`{
		"type": "doc",
		"content": [
			{
				"type": "heading",
				"attrs": {"level": 1},
				"content": [{"type": "text", "text": "Phase 5 smoke"}]
			},
			{
				"type": "paragraph",
				"content": [
					{"type": "text", "text": "before "},
					{
						"type": "text",
						"text": "INSERTED",
						"marks": [{
							"type": "suggestedInsert",
							"attrs": {
								"suggestionId": "s_insert",
								"authorId": "uo_alice",
								"ts": 1700000000000
							}
						}]
					},
					{"type": "text", "text": " after"}
				]
			},
			{
				"type": "paragraph",
				"content": [
					{"type": "text", "text": "keep "},
					{
						"type": "text",
						"text": "DELETED",
						"marks": [{
							"type": "suggestedDelete",
							"attrs": {
								"suggestionId": "s_delete",
								"authorId": "uo_alice",
								"ts": 1700000000000
							}
						}]
					},
					{"type": "text", "text": " keep"}
				]
			},
			{
				"type": "paragraph",
				"content": [
					{
						"type": "text",
						"text": "bolded",
						"marks": [
							{"type": "bold"},
							{
								"type": "suggestedFormatChange",
								"attrs": {
									"suggestionId": "s_format",
									"authorId": "uo_alice",
									"ts": 1700000000000,
									"before": [],
									"after": [{"type": "bold"}]
								}
							}
						]
					}
				]
			},
			{
				"type": "paragraph",
				"attrs": {
					"textAlign": "center",
					"suggestedBlockChange": {
						"suggestionId": "s_block",
						"authorId": "uo_alice",
						"ts": 1700000000000,
						"before": {"type": "paragraph", "attrs": {}},
						"after": {"type": "paragraph", "attrs": {"textAlign": "center"}}
					}
				},
				"content": [{"type": "text", "text": "centered"}]
			},
			{
				"type": "table",
				"content": [{
					"type": "tableRow",
					"content": [{
						"type": "tableCell",
						"attrs": {
							"shading": "#00FF00",
							"suggestedBlockChange": {
								"suggestionId": "s_cell",
								"authorId": "uo_alice",
								"ts": 1700000000000,
								"before": {"type": "tableCell", "attrs": {"shading": "#FF0000"}},
								"after": {"type": "tableCell", "attrs": {"shading": "#00FF00"}}
							}
						},
						"content": [{"type": "paragraph", "content": [{"type": "text", "text": "cell"}]}]
					}]
				}]
			}
		]
	}`)
	entries := []SuggestionMapEntry{
		{ID: "s_insert", AuthorID: "uo_alice", CreatedAt: 1700000000000, Status: "open"},
		{ID: "s_delete", AuthorID: "uo_alice", CreatedAt: 1700000000000, Status: "open"},
		{ID: "s_format", AuthorID: "uo_alice", CreatedAt: 1700000000000, Status: "open"},
		{ID: "s_block", AuthorID: "uo_alice", CreatedAt: 1700000000000, Status: "open"},
		{ID: "s_cell", AuthorID: "uo_alice", CreatedAt: 1700000000000, Status: "open"},
	}

	docxBytes, warnings, err := PMJSONToDocxWithSuggestions(t.Context(), pmJSON, entries)
	if err != nil {
		t.Fatalf("PM→docx: %v", err)
	}
	for _, w := range warnings {
		if w.Code == WarningCellContentFlattened {
			continue
		}
		t.Errorf("unexpected emit warning: %+v", w)
	}

	// Sanity-check: document.xml should carry all five OOXML revision
	// element types. A regression that conflates any two kinds shows up
	// as a missing element here.
	docXML := string(extractDocumentXMLForSuggestionTest(t, docxBytes))
	for _, need := range []string{
		"<w:ins ",        // Phase 2c insert
		"<w:del ",        // Phase 2c delete
		"<w:rPrChange ",  // Phase 5a format change
		"<w:pPrChange ",  // Phase 5b block change
		"<w:tcPrChange ", // Phase 5c cell change
	} {
		if !strings.Contains(docXML, need) {
			t.Errorf("expected %q in document.xml; got:\n%s", need, docXML)
		}
	}

	// All five suggestion mappings must be in the customXml part.
	customXML := string(extractCustomXMLForSuggestionTest(t, docxBytes))
	for _, kind := range []string{"insert", "delete", "formatChange", "blockChange", "cellChange"} {
		needle := `kind="` + kind + `"`
		if !strings.Contains(customXML, needle) {
			t.Errorf("expected mapping kind=%s in customXml; got:\n%s", kind, customXML)
		}
	}

	// Round-trip back to PM.
	roundtripped, _, parsedEntries, err := DocxToPMJSONWithSuggestions(t.Context(), docxBytes)
	if err != nil {
		t.Fatalf("docx→PM: %v", err)
	}

	var doc PMNode
	if err := json.Unmarshal(roundtripped, &doc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	// Collect every suggestionId we find anywhere in the tree: as a
	// mark on a text node, as a node-level suggestedBlockChange attr,
	// and as a parsedEntries entry. A surviving round-trip should hit
	// the same five suggestion ids from at least one source.
	foundFromTree := map[string]bool{}
	collectSuggestionIDs(&doc, foundFromTree)

	foundFromEntries := map[string]bool{}
	for _, e := range parsedEntries {
		foundFromEntries[e.ID] = true
	}

	wantedIDs := []string{"s_insert", "s_delete", "s_format", "s_block", "s_cell"}
	for _, id := range wantedIDs {
		if !foundFromTree[id] {
			t.Errorf("suggestion %q not found anywhere in roundtripped PM tree", id)
		}
		if !foundFromEntries[id] {
			t.Errorf("suggestion %q not found in roundtripped entries map", id)
		}
	}

	// Bonus check: parsedEntries should have exactly the five entries
	// we put in. A regression that introduces phantom entries shows up
	// as an unexpected entry count.
	if len(parsedEntries) != 5 {
		t.Errorf("parsedEntries count: got %d, want 5; entries=%+v", len(parsedEntries), parsedEntries)
	}
}

// collectSuggestionIDs walks the PM tree and stamps every suggestionId
// (from marks or node-level suggestedBlockChange attrs) into the given
// set. Used by the holistic round-trip test to detect any kind that
// silently fell off during PM → docx → PM.
func collectSuggestionIDs(n *PMNode, out map[string]bool) {
	if n == nil {
		return
	}
	// Marks on text nodes (suggestedInsert / suggestedDelete /
	// suggestedFormatChange).
	for _, m := range n.Marks {
		if id, ok := m.Attrs["suggestionId"].(string); ok && id != "" {
			out[id] = true
		}
	}
	// Node-level suggestedBlockChange attr (block changes on paragraphs
	// / headings / blockquotes / tableCells).
	if raw, ok := n.Attrs[NodeAttrSuggestedBlockChange]; ok && raw != nil {
		if payload, ok := raw.(map[string]any); ok {
			if id, ok := payload["suggestionId"].(string); ok && id != "" {
				out[id] = true
			}
		}
	}
	for i := range n.Content {
		collectSuggestionIDs(&n.Content[i], out)
	}
}

// extractCustomXMLForSuggestionTest is the customXml-part sibling of
// extractDocumentXMLForSuggestionTest. Returns the raw bytes of
// customXml/tinycld-suggestions.xml or fails the test if absent.
func extractCustomXMLForSuggestionTest(t *testing.T, docxBytes []byte) []byte {
	t.Helper()
	r, err := zip.NewReader(bytes.NewReader(docxBytes), int64(len(docxBytes)))
	if err != nil {
		t.Fatalf("zip: %v", err)
	}
	for _, f := range r.File {
		if f.Name == "customXml/tinycld-suggestions.xml" {
			rc, err := f.Open()
			if err != nil {
				t.Fatalf("open: %v", err)
			}
			defer rc.Close()
			data, err := io.ReadAll(rc)
			if err != nil {
				t.Fatalf("read: %v", err)
			}
			return data
		}
	}
	t.Fatalf("customXml/tinycld-suggestions.xml not found in docx")
	return nil
}
