package translate

import (
	"strings"
	"testing"
)

// TestQueueFormatChangeMarksProducesOneSpanPerMark mirrors the
// suggestion-marks equivalent: one PM mark produces one span, with the
// id/author/ts populated and the marker token uniquified.
func TestQueueFormatChangeMarksProducesOneSpanPerMark(t *testing.T) {
	em := newEmitter()
	marks := []PMMark{
		{
			Type: MarkTypeSuggestedFormatChange,
			Attrs: map[string]any{
				"suggestionId": "s_fc_1",
				"authorId":     "uo_alice",
				"ts":           float64(1700000000000),
				"before":       []any{},
				"after":        []any{map[string]any{"type": "bold"}},
			},
		},
		{Type: MarkTypeItalic},
	}
	spans := em.queueFormatChangeMarks(marks)
	if len(spans) != 1 {
		t.Fatalf("expected 1 span, got %d", len(spans))
	}
	if spans[0].SuggestionID != "s_fc_1" {
		t.Errorf("suggestionId: got %q want %q", spans[0].SuggestionID, "s_fc_1")
	}
	if spans[0].AuthorID != "uo_alice" {
		t.Errorf("authorId: got %q want %q", spans[0].AuthorID, "uo_alice")
	}
	if spans[0].Ts != 1700000000000 {
		t.Errorf("ts: got %d want %d", spans[0].Ts, 1700000000000)
	}
	if spans[0].DocxRevisionID != 1 {
		t.Errorf("DocxRevisionID: got %d want 1", spans[0].DocxRevisionID)
	}
	if len(spans[0].AfterMarks) != 1 || spans[0].AfterMarks[0].Type != "bold" {
		t.Errorf("AfterMarks: got %+v", spans[0].AfterMarks)
	}
}

func TestSerializedMarksToRPrChildrenCoversCommonShapes(t *testing.T) {
	marks := []serializedMark{
		{Type: "bold"},
		{Type: "italic"},
		{Type: "underline"},
		{Type: "strike"},
		{
			Type: "textStyle",
			Attrs: map[string]any{
				"color":           "#FF0000",
				"fontSize":        "14px",
				"fontFamily":      "Arial",
				"backgroundColor": "#FFFF00",
			},
		},
	}
	got := serializedMarksToRPrChildren(marks)
	for _, want := range []string{
		`<w:b/>`,
		`<w:i/>`,
		`<w:u w:val="single"/>`,
		`<w:strike/>`,
		`<w:color w:val="FF0000"/>`,
		`<w:sz w:val="21"/>`, // 14px == 21 half-points
		`<w:rFonts w:ascii="Arial" w:hAnsi="Arial"/>`,
		`<w:shd w:val="clear" w:color="auto" w:fill="FFFF00"/>`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("expected %q in rPr children, got:\n%s", want, got)
		}
	}
}

// TestPMToDocxEmitsWRPrChange confirms a suggestedFormatChange mark on
// a text run produces a <w:rPrChange> wrapper inside the run's <w:rPr>,
// with the BEFORE marks nested inside.
func TestPMToDocxEmitsWRPrChange(t *testing.T) {
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
							"suggestionId": "s_fc_1",
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

	docxBytes, _, err := PMJSONToDocxWithWarnings(pmJSON)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}

	docXML := string(extractDocumentXMLForSuggestionTest(t, docxBytes))
	if !strings.Contains(docXML, "<w:rPrChange ") {
		t.Fatalf("expected <w:rPrChange> in document.xml; got:\n%s", docXML)
	}
	if !strings.Contains(docXML, `w:author="uo_alice"`) {
		t.Errorf("expected w:author=uo_alice in rPrChange; got:\n%s", docXML)
	}
	if !strings.Contains(docXML, `w:id="1"`) {
		t.Errorf("expected w:id=\"1\" in rPrChange; got:\n%s", docXML)
	}
	// The marker text itself must be stripped.
	if strings.Contains(docXML, "{{__pmrpr:") {
		t.Errorf("marker text leaked into document.xml: %s", docXML)
	}
	// AFTER state (the outer rPr) should carry the bold toggle.
	// WordZero may emit either <w:b/> or <w:b></w:b>; accept either form.
	if !strings.Contains(docXML, `<w:b/>`) && !strings.Contains(docXML, `<w:b></w:b>`) {
		t.Errorf("expected <w:b/> for AFTER state bold; got:\n%s", docXML)
	}
}

// TestPMToDocxRPrChangeNestedRPrCarriesBeforeMarks confirms that the
// rPrChange's nested <w:rPr> holds the BEFORE marks (not the AFTER) —
// i.e. accept/reject can recover the pre-change formatting.
func TestPMToDocxRPrChangeNestedRPrCarriesBeforeMarks(t *testing.T) {
	pmJSON := []byte(`{
		"type": "doc",
		"content": [{
			"type": "paragraph",
			"content": [{
				"type": "text",
				"text": "italics-on",
				"marks": [
					{"type": "italic"},
					{
						"type": "suggestedFormatChange",
						"attrs": {
							"suggestionId": "s_fc_italic",
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

	docxBytes, _, err := PMJSONToDocxWithWarnings(pmJSON)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}

	docXML := string(extractDocumentXMLForSuggestionTest(t, docxBytes))
	// Locate the rPrChange and inspect its nested <w:rPr>.
	rPrChangeIdx := strings.Index(docXML, "<w:rPrChange ")
	if rPrChangeIdx < 0 {
		t.Fatalf("rPrChange missing: %s", docXML)
	}
	rPrChangeEndIdx := strings.Index(docXML[rPrChangeIdx:], "</w:rPrChange>")
	if rPrChangeEndIdx < 0 {
		t.Fatalf("rPrChange end missing: %s", docXML)
	}
	body := docXML[rPrChangeIdx : rPrChangeIdx+rPrChangeEndIdx]
	if !strings.Contains(body, `<w:b/>`) {
		t.Errorf("expected BEFORE state <w:b/> inside <w:rPrChange>'s nested rPr; got:\n%s", body)
	}
	if strings.Contains(body, `<w:i/>`) {
		t.Errorf("AFTER mark <w:i/> leaked into BEFORE rPr; got:\n%s", body)
	}
}
