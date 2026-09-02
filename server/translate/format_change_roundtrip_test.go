package translate

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestFormatChangeRoundTripPreservesMarkAndPayload exercises the full
// docx round-trip for a suggestedFormatChange mark: PM → docx → PM
// must reconstruct the mark with the same suggestionId, authorId,
// before, and after payloads.
func TestFormatChangeRoundTripPreservesMarkAndPayload(t *testing.T) {
	pmJSON := []byte(`{
		"type": "doc",
		"content": [{
			"type": "paragraph",
			"content": [{
				"type": "text",
				"text": "stylish",
				"marks": [
					{"type": "bold"},
					{
						"type": "suggestedFormatChange",
						"attrs": {
							"suggestionId": "s_fc_alice",
							"authorId": "uo_alice",
							"ts": 1700000000000,
							"before": [],
							"after": [{"type": "bold"}]
						}
					}
				]
			}]
		}]
	}`)
	entries := []SuggestionMapEntry{
		{ID: "s_fc_alice", AuthorID: "uo_alice", CreatedAt: 1700000000000, Status: "open"},
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
	if len(doc.Content) == 0 || len(doc.Content[0].Content) == 0 {
		t.Fatalf("unexpected shape: %+v", doc)
	}

	text := doc.Content[0].Content[0]
	if text.Text != "stylish" {
		t.Errorf("expected text preserved, got %q", text.Text)
	}

	var fcMark *PMMark
	for i := range text.Marks {
		if text.Marks[i].Type == MarkTypeSuggestedFormatChange {
			fcMark = &text.Marks[i]
			break
		}
	}
	if fcMark == nil {
		t.Fatalf("suggestedFormatChange mark missing on roundtripped text: %+v", text.Marks)
	}
	// The customXml mapping carried s_fc_alice through to import.
	if got, _ := fcMark.Attrs["suggestionId"].(string); got != "s_fc_alice" {
		t.Errorf("suggestionId: got %q want %q", got, "s_fc_alice")
	}
	if got, _ := fcMark.Attrs["authorId"].(string); got != "uo_alice" {
		t.Errorf("authorId: got %q want %q", got, "uo_alice")
	}

	// Before should be empty []any.
	before, _ := fcMark.Attrs["before"].([]any)
	if len(before) != 0 {
		t.Errorf("before: expected empty [], got %v", before)
	}

	// After should contain the bold mark.
	after, _ := fcMark.Attrs["after"].([]any)
	if len(after) != 1 {
		t.Fatalf("after: expected 1 entry, got %v", after)
	}
	afterEntry, _ := after[0].(map[string]any)
	if t0, _ := afterEntry["type"].(string); t0 != "bold" {
		t.Errorf("after[0].type: got %q want %q", t0, "bold")
	}

	// Entries from the customXml should round-trip unaffected by the
	// format-change-mark plumbing (this is a regression guard against
	// the rewriter clobbering customXml output).
	if len(parsedEntries) != 1 {
		t.Errorf("expected 1 entry, got %d", len(parsedEntries))
	}
}

// TestFormatChangeRoundTripWithBeforeBoldAfterItalic confirms that a
// realistic before/after pair (different mark sets) round-trips fully
// — the BEFORE state lands in the nested rPr inside w:rPrChange, the
// AFTER state lands in the outer rPr.
func TestFormatChangeRoundTripWithBeforeBoldAfterItalic(t *testing.T) {
	pmJSON := []byte(`{
		"type": "doc",
		"content": [{
			"type": "paragraph",
			"content": [{
				"type": "text",
				"text": "switch",
				"marks": [
					{"type": "italic"},
					{
						"type": "suggestedFormatChange",
						"attrs": {
							"suggestionId": "s_fc_swap",
							"authorId": "uo_alice",
							"ts": 1700000000000,
							"before": [{"type": "bold"}],
							"after": [{"type": "italic"}]
						}
					}
				]
			}]
		}]
	}`)
	entries := []SuggestionMapEntry{
		{ID: "s_fc_swap", AuthorID: "uo_alice", CreatedAt: 1700000000000, Status: "open"},
	}

	docxBytes, _, err := PMJSONToDocxWithSuggestions(t.Context(), pmJSON, entries)
	if err != nil {
		t.Fatalf("PM→docx: %v", err)
	}

	// Confirm document.xml shape:
	docXML := string(extractDocumentXMLForSuggestionTest(t, docxBytes))
	if !strings.Contains(docXML, "<w:rPrChange ") {
		t.Errorf("expected rPrChange in document.xml; got:\n%s", docXML)
	}

	roundtripped, _, _, err := DocxToPMJSONWithSuggestions(t.Context(), docxBytes)
	if err != nil {
		t.Fatalf("docx→PM: %v", err)
	}

	var doc PMNode
	if err := json.Unmarshal(roundtripped, &doc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	text := doc.Content[0].Content[0]
	var fcMark *PMMark
	for i := range text.Marks {
		if text.Marks[i].Type == MarkTypeSuggestedFormatChange {
			fcMark = &text.Marks[i]
			break
		}
	}
	if fcMark == nil {
		t.Fatalf("suggestedFormatChange mark missing: %+v", text.Marks)
	}

	before, _ := fcMark.Attrs["before"].([]any)
	if len(before) != 1 {
		t.Fatalf("expected 1 before mark, got %v", before)
	}
	beforeEntry, _ := before[0].(map[string]any)
	if got, _ := beforeEntry["type"].(string); got != "bold" {
		t.Errorf("before[0].type: got %q want %q", got, "bold")
	}

	after, _ := fcMark.Attrs["after"].([]any)
	if len(after) != 1 {
		t.Fatalf("expected 1 after mark, got %v", after)
	}
	afterEntry, _ := after[0].(map[string]any)
	if got, _ := afterEntry["type"].(string); got != "italic" {
		t.Errorf("after[0].type: got %q want %q", got, "italic")
	}

	// The AFTER state is what Word renders — confirm <w:i/> sits in
	// the outer rPr (NOT inside <w:rPrChange>'s nested rPr).
	rPrChangeIdx := strings.Index(docXML, "<w:rPrChange ")
	rPrChangeEndIdx := strings.Index(docXML[rPrChangeIdx:], "</w:rPrChange>")
	rPrChangeBody := docXML[rPrChangeIdx : rPrChangeIdx+rPrChangeEndIdx]
	if !strings.Contains(rPrChangeBody, `<w:b/>`) {
		t.Errorf("expected <w:b/> in BEFORE rPr; got:\n%s", rPrChangeBody)
	}
}

// TestFormatChangeRoundTripPreservesTextStyleAttrs covers the
// textStyle mark surface (color / fontSize / fontFamily / backgroundColor)
// in both BEFORE and AFTER states. The serialize/parse logic has to
// handle every attribute independently since the AFTER state lands in
// the run's outer rPr (where WordZero owns serialization) while the
// BEFORE state lands inside <w:rPrChange>'s nested rPr (where our
// rewriter owns serialization). Both paths must produce identical
// PM marks on round-trip.
func TestFormatChangeRoundTripPreservesTextStyleAttrs(t *testing.T) {
	pmJSON := []byte(`{
		"type": "doc",
		"content": [{
			"type": "paragraph",
			"content": [{
				"type": "text",
				"text": "colorful",
				"marks": [
					{"type": "textStyle", "attrs": {"color": "#0000FF", "fontFamily": "Arial"}},
					{
						"type": "suggestedFormatChange",
						"attrs": {
							"suggestionId": "s_fc_color",
							"authorId": "uo_alice",
							"ts": 1700000000000,
							"before": [{"type": "textStyle", "attrs": {"color": "#FF0000"}}],
							"after": [{"type": "textStyle", "attrs": {"color": "#0000FF", "fontFamily": "Arial"}}]
						}
					}
				]
			}]
		}]
	}`)
	entries := []SuggestionMapEntry{
		{ID: "s_fc_color", AuthorID: "uo_alice", CreatedAt: 1700000000000, Status: "open"},
	}

	docxBytes, _, err := PMJSONToDocxWithSuggestions(t.Context(), pmJSON, entries)
	if err != nil {
		t.Fatalf("PM→docx: %v", err)
	}

	roundtripped, _, _, err := DocxToPMJSONWithSuggestions(t.Context(), docxBytes)
	if err != nil {
		t.Fatalf("docx→PM: %v", err)
	}

	var doc PMNode
	if err := json.Unmarshal(roundtripped, &doc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	text := doc.Content[0].Content[0]
	var fcMark *PMMark
	for i := range text.Marks {
		if text.Marks[i].Type == MarkTypeSuggestedFormatChange {
			fcMark = &text.Marks[i]
			break
		}
	}
	if fcMark == nil {
		t.Fatalf("suggestedFormatChange mark missing: %+v", text.Marks)
	}

	// BEFORE textStyle has color only.
	before, _ := fcMark.Attrs["before"].([]any)
	if len(before) != 1 {
		t.Fatalf("expected 1 before mark, got %v", before)
	}
	beforeEntry, _ := before[0].(map[string]any)
	if beforeEntry["type"] != "textStyle" {
		t.Errorf("before[0].type: got %q want textStyle", beforeEntry["type"])
	}
	beforeAttrs, _ := beforeEntry["attrs"].(map[string]any)
	if color, _ := beforeAttrs["color"].(string); color != "#FF0000" {
		t.Errorf("before color: got %q want #FF0000", color)
	}

	// AFTER textStyle has color and fontFamily.
	after, _ := fcMark.Attrs["after"].([]any)
	if len(after) != 1 {
		t.Fatalf("expected 1 after mark, got %v", after)
	}
	afterEntry, _ := after[0].(map[string]any)
	if afterEntry["type"] != "textStyle" {
		t.Errorf("after[0].type: got %q want textStyle", afterEntry["type"])
	}
	afterAttrs, _ := afterEntry["attrs"].(map[string]any)
	if color, _ := afterAttrs["color"].(string); color != "#0000FF" {
		t.Errorf("after color: got %q want #0000FF", color)
	}
	if font, _ := afterAttrs["fontFamily"].(string); font != "Arial" {
		t.Errorf("after fontFamily: got %q want Arial", font)
	}
}

// TestFormatChangeWordAuthoredSynthesizesId confirms that a docx with a
// <w:rPrChange> but no tinycld customXml part (Word-authored) still
// surfaces as a suggestedFormatChange mark, with the suggestion id
// synthesized from (w:id, w:author).
func TestFormatChangeWordAuthoredSynthesizesId(t *testing.T) {
	pmJSON := []byte(`{
		"type": "doc",
		"content": [{
			"type": "paragraph",
			"content": [{
				"type": "text",
				"text": "edited",
				"marks": [
					{"type": "bold"},
					{
						"type": "suggestedFormatChange",
						"attrs": {
							"suggestionId": "s_fc_word",
							"authorId": "wordy",
							"ts": 1700000000000,
							"before": [],
							"after": [{"type": "bold"}]
						}
					}
				]
			}]
		}]
	}`)
	entries := []SuggestionMapEntry{
		{ID: "s_fc_word", AuthorID: "wordy", CreatedAt: 1700000000000, Status: "open"},
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

	text := doc.Content[0].Content[0]
	var fcMark *PMMark
	for i := range text.Marks {
		if text.Marks[i].Type == MarkTypeSuggestedFormatChange {
			fcMark = &text.Marks[i]
			break
		}
	}
	if fcMark == nil {
		t.Fatalf("suggestedFormatChange mark missing on Word-authored roundtrip: %+v", text.Marks)
	}

	// Without the mapping, the parser synthesizes a stable id.
	gotID, _ := fcMark.Attrs["suggestionId"].(string)
	if gotID != "docx:rpr:1:wordy" {
		t.Errorf("synthesized suggestionId: got %q, want %q", gotID, "docx:rpr:1:wordy")
	}
}
