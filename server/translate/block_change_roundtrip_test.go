package translate

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestBlockChangeRoundTripAttrOnlyChange exercises the attr-only case:
// a paragraph whose suggestedBlockChange records the alignment changed
// from default (left, none) to center.
func TestBlockChangeRoundTripAttrOnlyChange(t *testing.T) {
	pmJSON := []byte(`{
		"type": "doc",
		"content": [{
			"type": "paragraph",
			"attrs": {
				"textAlign": "center",
				"suggestedBlockChange": {
					"suggestionId": "s_bc_align",
					"authorId": "uo_alice",
					"ts": 1700000000000,
					"before": {"type": "paragraph", "attrs": {}},
					"after": {"type": "paragraph", "attrs": {"textAlign": "center"}}
				}
			},
			"content": [{"type": "text", "text": "centered"}]
		}]
	}`)
	entries := []SuggestionMapEntry{
		{ID: "s_bc_align", AuthorID: "uo_alice", CreatedAt: 1700000000000, Status: "open"},
	}

	docxBytes, _, err := PMJSONToDocxWithSuggestions(t.Context(), pmJSON, entries)
	if err != nil {
		t.Fatalf("PM→docx: %v", err)
	}

	roundtripped, _, parsedEntries, err := DocxToPMJSONWithSuggestions(t.Context(), docxBytes)
	if err != nil {
		t.Fatalf("docx→PM: %v", err)
	}

	var doc PMNode
	if err := json.Unmarshal(roundtripped, &doc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(doc.Content) == 0 {
		t.Fatalf("unexpected shape: %+v", doc)
	}

	para := doc.Content[0]
	if para.Type != NodeTypeParagraph {
		t.Errorf("expected paragraph, got %q", para.Type)
	}
	if v, _ := para.Attrs["textAlign"].(string); v != "center" {
		t.Errorf("expected textAlign=center, got %v", para.Attrs["textAlign"])
	}

	bcRaw, ok := para.Attrs[NodeAttrSuggestedBlockChange]
	if !ok || bcRaw == nil {
		t.Fatalf("suggestedBlockChange missing on roundtripped paragraph: %+v", para.Attrs)
	}
	bc, ok := bcRaw.(map[string]any)
	if !ok {
		t.Fatalf("suggestedBlockChange wrong shape: %+v", bcRaw)
	}
	if got, _ := bc["suggestionId"].(string); got != "s_bc_align" {
		t.Errorf("suggestionId: got %q want %q", got, "s_bc_align")
	}
	if got, _ := bc["authorId"].(string); got != "uo_alice" {
		t.Errorf("authorId: got %q want %q", got, "uo_alice")
	}

	before, _ := bc["before"].(map[string]any)
	if before == nil {
		t.Fatalf("before missing in roundtripped block change")
	}
	if bt, _ := before["type"].(string); bt != NodeTypeParagraph {
		t.Errorf("before.type: got %q want %q", bt, NodeTypeParagraph)
	}
	beforeAttrs, _ := before["attrs"].(map[string]any)
	if _, hasAlign := beforeAttrs["textAlign"]; hasAlign {
		t.Errorf("before.attrs.textAlign should be absent (default left); got %v", beforeAttrs)
	}

	after, _ := bc["after"].(map[string]any)
	if after == nil {
		t.Fatalf("after missing in roundtripped block change")
	}
	if at, _ := after["type"].(string); at != NodeTypeParagraph {
		t.Errorf("after.type: got %q want %q", at, NodeTypeParagraph)
	}
	afterAttrs, _ := after["attrs"].(map[string]any)
	if got, _ := afterAttrs["textAlign"].(string); got != "center" {
		t.Errorf("after.attrs.textAlign: got %q want %q", got, "center")
	}

	if len(parsedEntries) != 1 {
		t.Errorf("expected 1 entry, got %d", len(parsedEntries))
	}
}

// TestBlockChangeRoundTripTypeSwap exercises the type-swap case: the
// paragraph is being proposed for promotion to a Heading2. Before
// state is paragraph (no pStyle); after state is heading level 2.
func TestBlockChangeRoundTripTypeSwap(t *testing.T) {
	pmJSON := []byte(`{
		"type": "doc",
		"content": [{
			"type": "heading",
			"attrs": {
				"level": 2,
				"suggestedBlockChange": {
					"suggestionId": "s_bc_promote",
					"authorId": "uo_alice",
					"ts": 1700000000000,
					"before": {"type": "paragraph", "attrs": {}},
					"after": {"type": "heading", "attrs": {"level": 2}}
				}
			},
			"content": [{"type": "text", "text": "Promoted"}]
		}]
	}`)
	entries := []SuggestionMapEntry{
		{ID: "s_bc_promote", AuthorID: "uo_alice", CreatedAt: 1700000000000, Status: "open"},
	}

	docxBytes, _, err := PMJSONToDocxWithSuggestions(t.Context(), pmJSON, entries)
	if err != nil {
		t.Fatalf("PM→docx: %v", err)
	}

	// Confirm document.xml carries the pPrChange wrapper.
	docXML := string(extractDocumentXMLForSuggestionTest(t, docxBytes))
	if !strings.Contains(docXML, "<w:pPrChange ") {
		t.Errorf("expected <w:pPrChange> in document.xml; got:\n%s", docXML)
	}

	roundtripped, _, _, err := DocxToPMJSONWithSuggestions(t.Context(), docxBytes)
	if err != nil {
		t.Fatalf("docx→PM: %v", err)
	}

	var doc PMNode
	if err := json.Unmarshal(roundtripped, &doc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	heading := doc.Content[0]
	if heading.Type != NodeTypeHeading {
		t.Errorf("expected heading, got %q", heading.Type)
	}
	if lvl, _ := heading.Attrs["level"].(float64); lvl != 2 {
		t.Errorf("expected level=2, got %v", heading.Attrs["level"])
	}

	bc, ok := heading.Attrs[NodeAttrSuggestedBlockChange].(map[string]any)
	if !ok {
		t.Fatalf("block-change attr missing on heading: %+v", heading.Attrs)
	}
	before, _ := bc["before"].(map[string]any)
	if bt, _ := before["type"].(string); bt != NodeTypeParagraph {
		t.Errorf("before.type: got %q want %q", bt, NodeTypeParagraph)
	}

	after, _ := bc["after"].(map[string]any)
	if at, _ := after["type"].(string); at != NodeTypeHeading {
		t.Errorf("after.type: got %q want %q", at, NodeTypeHeading)
	}
	afterAttrs, _ := after["attrs"].(map[string]any)
	if lvl, _ := afterAttrs["level"].(float64); lvl != 2 {
		t.Errorf("after.attrs.level: got %v want 2", afterAttrs["level"])
	}
}

// TestBlockChangeRoundTripDeleteSubcase exercises the delete sub-case:
// the paragraph has both a suggestedDelete mark on the inline content
// (Phase 2c) AND a suggestedBlockChange attr with after.deleted=true.
// The pPrChange wrapper records the block-level delete intent; the
// inline content rides Phase 2c's <w:del> wrapper.
func TestBlockChangeRoundTripDeleteSubcase(t *testing.T) {
	pmJSON := []byte(`{
		"type": "doc",
		"content": [{
			"type": "paragraph",
			"attrs": {
				"suggestedBlockChange": {
					"suggestionId": "s_bc_del",
					"authorId": "uo_alice",
					"ts": 1700000000000,
					"before": {"type": "paragraph", "attrs": {}},
					"after": {"type": "paragraph", "attrs": {}, "deleted": true}
				}
			},
			"content": [{
				"type": "text",
				"text": "delete me",
				"marks": [{
					"type": "suggestedDelete",
					"attrs": {
						"suggestionId": "s_bc_del",
						"authorId": "uo_alice",
						"ts": 1700000000000
					}
				}]
			}]
		}]
	}`)
	entries := []SuggestionMapEntry{
		{ID: "s_bc_del", AuthorID: "uo_alice", CreatedAt: 1700000000000, Status: "open"},
	}

	docxBytes, _, err := PMJSONToDocxWithSuggestions(t.Context(), pmJSON, entries)
	if err != nil {
		t.Fatalf("PM→docx: %v", err)
	}

	// Both the <w:del> (for inline content) and the <w:pPrChange> (for
	// paragraph-level marker) should be present in document.xml.
	docXML := string(extractDocumentXMLForSuggestionTest(t, docxBytes))
	if !strings.Contains(docXML, "<w:del ") {
		t.Errorf("expected <w:del> wrapper from Phase 2c suggestedDelete; got:\n%s", docXML)
	}
	if !strings.Contains(docXML, "<w:pPrChange ") {
		t.Errorf("expected <w:pPrChange> wrapper from Task 19 block-change; got:\n%s", docXML)
	}

	roundtripped, _, _, err := DocxToPMJSONWithSuggestions(t.Context(), docxBytes)
	if err != nil {
		t.Fatalf("docx→PM: %v", err)
	}

	var doc PMNode
	if err := json.Unmarshal(roundtripped, &doc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	para := doc.Content[0]
	if para.Type != NodeTypeParagraph {
		t.Errorf("expected paragraph, got %q", para.Type)
	}

	// The paragraph attrs carry the block change.
	bc, ok := para.Attrs[NodeAttrSuggestedBlockChange].(map[string]any)
	if !ok {
		t.Fatalf("block-change attr missing on paragraph: %+v", para.Attrs)
	}
	if id, _ := bc["suggestionId"].(string); id != "s_bc_del" {
		t.Errorf("suggestionId: got %q want %q", id, "s_bc_del")
	}

	// The inline content carries the suggestedDelete mark.
	if len(para.Content) == 0 {
		t.Fatalf("expected inline content surviving the round-trip")
	}
	text := para.Content[0]
	if text.Text != "delete me" {
		t.Errorf("text content: got %q want %q", text.Text, "delete me")
	}
	var delMark *PMMark
	for i := range text.Marks {
		if text.Marks[i].Type == MarkTypeSuggestedDelete {
			delMark = &text.Marks[i]
			break
		}
	}
	if delMark == nil {
		t.Errorf("expected suggestedDelete mark to survive round-trip, got: %+v", text.Marks)
	}
}

// TestBlockChangeWordAuthoredSynthesizesId confirms a docx with a
// <w:pPrChange> but no tinycld customXml part (Word-authored) still
// surfaces the suggestedBlockChange attribute, with the suggestion id
// synthesized from (w:id, w:author).
func TestBlockChangeWordAuthoredSynthesizesId(t *testing.T) {
	pmJSON := []byte(`{
		"type": "doc",
		"content": [{
			"type": "heading",
			"attrs": {
				"level": 1,
				"suggestedBlockChange": {
					"suggestionId": "s_bc_wordy",
					"authorId": "wordy",
					"ts": 1700000000000,
					"before": {"type": "paragraph", "attrs": {}},
					"after": {"type": "heading", "attrs": {"level": 1}}
				}
			},
			"content": [{"type": "text", "text": "h1"}]
		}]
	}`)
	entries := []SuggestionMapEntry{
		{ID: "s_bc_wordy", AuthorID: "wordy", CreatedAt: 1700000000000, Status: "open"},
	}

	docxBytes, _, err := PMJSONToDocxWithSuggestions(t.Context(), pmJSON, entries)
	if err != nil {
		t.Fatalf("PM→docx: %v", err)
	}

	stripped := stripCustomXMLPart(t, docxBytes)

	roundtripped, _, err := DocxToPMJSON(t.Context(), stripped)
	if err != nil {
		t.Fatalf("docx→PM: %v", err)
	}

	var doc PMNode
	if err := json.Unmarshal(roundtripped, &doc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	heading := doc.Content[0]
	bc, ok := heading.Attrs[NodeAttrSuggestedBlockChange].(map[string]any)
	if !ok {
		t.Fatalf("block-change attr missing on Word-authored heading: %+v", heading.Attrs)
	}
	gotID, _ := bc["suggestionId"].(string)
	if gotID != "docx:ppr:1:wordy" {
		t.Errorf("synthesized suggestionId: got %q, want %q", gotID, "docx:ppr:1:wordy")
	}
}
