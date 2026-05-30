package translate

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestCellChangeRoundTripAttrOnlyChange exercises the attr-only case:
// a tableCell whose suggestedBlockChange records the shading changed
// from one color to another. The wrapper element is <w:tcPrChange>.
func TestCellChangeRoundTripAttrOnlyChange(t *testing.T) {
	pmJSON := []byte(`{
		"type": "doc",
		"content": [{
			"type": "table",
			"content": [{
				"type": "tableRow",
				"content": [{
					"type": "tableCell",
					"attrs": {
						"shading": "#00FF00",
						"suggestedBlockChange": {
							"suggestionId": "s_cc_attr",
							"authorId": "uo_alice",
							"ts": 1700000000000,
							"before": {"type": "tableCell", "attrs": {"shading": "#FF0000"}},
							"after": {"type": "tableCell", "attrs": {"shading": "#00FF00"}}
						}
					},
					"content": [{"type": "paragraph", "content": [{"type": "text", "text": "cell"}]}]
				}]
			}]
		}]
	}`)
	entries := []SuggestionMapEntry{
		{ID: "s_cc_attr", AuthorID: "uo_alice", CreatedAt: 1700000000000, Status: "open"},
	}

	docxBytes, _, err := PMJSONToDocxWithSuggestions(pmJSON, entries)
	if err != nil {
		t.Fatalf("PM→docx: %v", err)
	}

	// Confirm document.xml carries the tcPrChange wrapper.
	docXML := string(extractDocumentXMLForSuggestionTest(t, docxBytes))
	if !strings.Contains(docXML, "<w:tcPrChange ") {
		t.Errorf("expected <w:tcPrChange> in document.xml; got:\n%s", docXML)
	}

	roundtripped, _, parsedEntries, err := DocxToPMJSONWithSuggestions(docxBytes)
	if err != nil {
		t.Fatalf("docx→PM: %v", err)
	}

	var doc PMNode
	if err := json.Unmarshal(roundtripped, &doc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	cell := findFirstNodeByType(&doc, NodeTypeTableCell)
	if cell == nil {
		t.Fatalf("no tableCell after round-trip; doc=%+v", doc)
	}

	bcRaw, ok := cell.Attrs[NodeAttrSuggestedBlockChange]
	if !ok || bcRaw == nil {
		t.Fatalf("suggestedBlockChange missing on roundtripped cell: %+v", cell.Attrs)
	}
	bc, ok := bcRaw.(map[string]any)
	if !ok {
		t.Fatalf("suggestedBlockChange wrong shape: %+v", bcRaw)
	}
	if got, _ := bc["suggestionId"].(string); got != "s_cc_attr" {
		t.Errorf("suggestionId: got %q want %q", got, "s_cc_attr")
	}
	if got, _ := bc["authorId"].(string); got != "uo_alice" {
		t.Errorf("authorId: got %q want %q", got, "uo_alice")
	}

	before, _ := bc["before"].(map[string]any)
	if before == nil {
		t.Fatalf("before missing in roundtripped cell change")
	}
	beforeAttrs, _ := before["attrs"].(map[string]any)
	if got, _ := beforeAttrs["shading"].(string); got != "#FF0000" {
		t.Errorf("before.attrs.shading: got %q want %q", got, "#FF0000")
	}

	after, _ := bc["after"].(map[string]any)
	if after == nil {
		t.Fatalf("after missing in roundtripped cell change")
	}
	afterAttrs, _ := after["attrs"].(map[string]any)
	if got, _ := afterAttrs["shading"].(string); got != "#00FF00" {
		t.Errorf("after.attrs.shading: got %q want %q", got, "#00FF00")
	}

	if len(parsedEntries) != 1 {
		t.Errorf("expected 1 entry, got %d", len(parsedEntries))
	}
}

// TestCellChangeRoundTripAddedSubcase exercises the cell-added case:
// the cell is being proposed for addition. The wrapper element is
// <w:cellIns>, and the cell content stays in the doc until accepted.
// On round-trip, before.added=true must survive.
func TestCellChangeRoundTripAddedSubcase(t *testing.T) {
	pmJSON := []byte(`{
		"type": "doc",
		"content": [{
			"type": "table",
			"content": [{
				"type": "tableRow",
				"content": [{
					"type": "tableCell",
					"attrs": {
						"suggestedBlockChange": {
							"suggestionId": "s_cc_ins",
							"authorId": "uo_alice",
							"ts": 1700000000000,
							"before": {"type": "tableCell", "attrs": {}, "added": true},
							"after": {"type": "tableCell", "attrs": {}}
						}
					},
					"content": [{"type": "paragraph", "content": [{"type": "text", "text": "new cell"}]}]
				}]
			}]
		}]
	}`)
	entries := []SuggestionMapEntry{
		{ID: "s_cc_ins", AuthorID: "uo_alice", CreatedAt: 1700000000000, Status: "open"},
	}

	docxBytes, _, err := PMJSONToDocxWithSuggestions(pmJSON, entries)
	if err != nil {
		t.Fatalf("PM→docx: %v", err)
	}

	docXML := string(extractDocumentXMLForSuggestionTest(t, docxBytes))
	if !strings.Contains(docXML, "<w:cellIns ") {
		t.Errorf("expected <w:cellIns> in document.xml; got:\n%s", docXML)
	}

	roundtripped, _, _, err := DocxToPMJSONWithSuggestions(docxBytes)
	if err != nil {
		t.Fatalf("docx→PM: %v", err)
	}

	var doc PMNode
	if err := json.Unmarshal(roundtripped, &doc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	cell := findFirstNodeByType(&doc, NodeTypeTableCell)
	if cell == nil {
		t.Fatalf("no tableCell after round-trip; doc=%+v", doc)
	}
	bc, ok := cell.Attrs[NodeAttrSuggestedBlockChange].(map[string]any)
	if !ok {
		t.Fatalf("cell-change attr missing on roundtripped cell: %+v", cell.Attrs)
	}
	before, _ := bc["before"].(map[string]any)
	if before == nil {
		t.Fatalf("before missing")
	}
	added, _ := before["added"].(bool)
	if !added {
		t.Errorf("expected before.added=true on roundtripped cell-add; got before=%+v", before)
	}
}

// TestCellChangeRoundTripDeletedSubcase exercises the cell-deleted
// case: the cell is being proposed for removal. The wrapper element
// is <w:cellDel>, and the cell content stays in the doc until
// resolved. On round-trip, after.deleted=true must survive.
func TestCellChangeRoundTripDeletedSubcase(t *testing.T) {
	pmJSON := []byte(`{
		"type": "doc",
		"content": [{
			"type": "table",
			"content": [{
				"type": "tableRow",
				"content": [{
					"type": "tableCell",
					"attrs": {
						"suggestedBlockChange": {
							"suggestionId": "s_cc_del",
							"authorId": "uo_alice",
							"ts": 1700000000000,
							"before": {"type": "tableCell", "attrs": {}},
							"after": {"type": "tableCell", "attrs": {}, "deleted": true}
						}
					},
					"content": [{"type": "paragraph", "content": [{"type": "text", "text": "old cell"}]}]
				}]
			}]
		}]
	}`)
	entries := []SuggestionMapEntry{
		{ID: "s_cc_del", AuthorID: "uo_alice", CreatedAt: 1700000000000, Status: "open"},
	}

	docxBytes, _, err := PMJSONToDocxWithSuggestions(pmJSON, entries)
	if err != nil {
		t.Fatalf("PM→docx: %v", err)
	}

	docXML := string(extractDocumentXMLForSuggestionTest(t, docxBytes))
	if !strings.Contains(docXML, "<w:cellDel ") {
		t.Errorf("expected <w:cellDel> in document.xml; got:\n%s", docXML)
	}

	roundtripped, _, _, err := DocxToPMJSONWithSuggestions(docxBytes)
	if err != nil {
		t.Fatalf("docx→PM: %v", err)
	}

	var doc PMNode
	if err := json.Unmarshal(roundtripped, &doc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	cell := findFirstNodeByType(&doc, NodeTypeTableCell)
	if cell == nil {
		t.Fatalf("no tableCell after round-trip; doc=%+v", doc)
	}
	bc, ok := cell.Attrs[NodeAttrSuggestedBlockChange].(map[string]any)
	if !ok {
		t.Fatalf("cell-change attr missing on roundtripped cell: %+v", cell.Attrs)
	}
	after, _ := bc["after"].(map[string]any)
	if after == nil {
		t.Fatalf("after missing")
	}
	deleted, _ := after["deleted"].(bool)
	if !deleted {
		t.Errorf("expected after.deleted=true on roundtripped cell-del; got after=%+v", after)
	}
}

// TestCellChangeWordAuthoredSynthesizesId confirms a docx with a
// <w:tcPrChange> but no tinycld customXml part (Word-authored) still
// surfaces the suggestedBlockChange attribute, with the suggestion id
// synthesized from (w:id, w:author). Mirrors the Phase 2c / Task 19
// fallback used for Word-authored format and block changes.
func TestCellChangeWordAuthoredSynthesizesId(t *testing.T) {
	pmJSON := []byte(`{
		"type": "doc",
		"content": [{
			"type": "table",
			"content": [{
				"type": "tableRow",
				"content": [{
					"type": "tableCell",
					"attrs": {
						"shading": "#0000FF",
						"suggestedBlockChange": {
							"suggestionId": "s_cc_wordy",
							"authorId": "wordy",
							"ts": 1700000000000,
							"before": {"type": "tableCell", "attrs": {"shading": "#FF0000"}},
							"after": {"type": "tableCell", "attrs": {"shading": "#0000FF"}}
						}
					},
					"content": [{"type": "paragraph", "content": [{"type": "text", "text": "wordy cell"}]}]
				}]
			}]
		}]
	}`)
	entries := []SuggestionMapEntry{
		{ID: "s_cc_wordy", AuthorID: "wordy", CreatedAt: 1700000000000, Status: "open"},
	}

	docxBytes, _, err := PMJSONToDocxWithSuggestions(pmJSON, entries)
	if err != nil {
		t.Fatalf("PM→docx: %v", err)
	}

	stripped := stripCustomXMLPart(t, docxBytes)

	roundtripped, _, err := DocxToPMJSON(stripped)
	if err != nil {
		t.Fatalf("docx→PM: %v", err)
	}

	var doc PMNode
	if err := json.Unmarshal(roundtripped, &doc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	cell := findFirstNodeByType(&doc, NodeTypeTableCell)
	if cell == nil {
		t.Fatalf("no tableCell after round-trip; doc=%+v", doc)
	}
	bc, ok := cell.Attrs[NodeAttrSuggestedBlockChange].(map[string]any)
	if !ok {
		t.Fatalf("cell-change attr missing on Word-authored cell: %+v", cell.Attrs)
	}
	gotID, _ := bc["suggestionId"].(string)
	if gotID != "docx:tcpr:1:wordy" {
		t.Errorf("synthesized suggestionId: got %q, want %q", gotID, "docx:tcpr:1:wordy")
	}
}
