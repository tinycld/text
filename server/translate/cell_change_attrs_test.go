package translate

import (
	"strings"
	"testing"
)

// TestQueueCellChangeAttrsProducesOneSpanPerNode confirms the emitter
// records a cellChangeSpan when a cell node carries a
// suggestedBlockChange attribute and synthesizes a fresh
// DocxRevisionID + marker token for each one.
func TestQueueCellChangeAttrsProducesOneSpanPerNode(t *testing.T) {
	em := newEmitter()
	attrs := map[string]any{
		NodeAttrSuggestedBlockChange: map[string]any{
			"suggestionId": "s_cc_attr",
			"authorId":     "uo_alice",
			"ts":           float64(1700000000000),
			"before": map[string]any{
				"type":  NodeTypeTableCell,
				"attrs": map[string]any{"shading": "#FF0000"},
			},
			"after": map[string]any{
				"type":  NodeTypeTableCell,
				"attrs": map[string]any{"shading": "#00FF00"},
			},
		},
	}
	span := em.queueCellChangeAttrs(attrs)
	if span == nil {
		t.Fatalf("expected span, got nil")
	}
	if span.SuggestionID != "s_cc_attr" {
		t.Errorf("suggestionId: got %q want %q", span.SuggestionID, "s_cc_attr")
	}
	if span.AuthorID != "uo_alice" {
		t.Errorf("authorId: got %q want %q", span.AuthorID, "uo_alice")
	}
	if span.DocxRevisionID != 1 {
		t.Errorf("DocxRevisionID: got %d want 1", span.DocxRevisionID)
	}
	if span.Kind != cellChangeKindAttr {
		t.Errorf("Kind: got %v want cellChangeKindAttr", span.Kind)
	}
	if span.BeforeShading != "#FF0000" {
		t.Errorf("BeforeShading: got %q want %q", span.BeforeShading, "#FF0000")
	}
	if !strings.HasPrefix(span.Marker, "{{__pmtcpr:") {
		t.Errorf("Marker token: got %q want prefix {{__pmtcpr:", span.Marker)
	}
	if len(em.cellChangeSpans) != 1 {
		t.Errorf("emitter span queue: got %d want 1", len(em.cellChangeSpans))
	}
}

// TestQueueCellChangeAttrsDetectsAddedSubcase confirms before.added=true
// flips Kind to cellChangeKindIns.
func TestQueueCellChangeAttrsDetectsAddedSubcase(t *testing.T) {
	em := newEmitter()
	attrs := map[string]any{
		NodeAttrSuggestedBlockChange: map[string]any{
			"suggestionId": "s_cc_added",
			"authorId":     "uo_alice",
			"ts":           float64(1700000000000),
			"before": map[string]any{
				"type":  NodeTypeTableCell,
				"attrs": map[string]any{},
				"added": true,
			},
			"after": map[string]any{
				"type":  NodeTypeTableCell,
				"attrs": map[string]any{},
			},
		},
	}
	span := em.queueCellChangeAttrs(attrs)
	if span == nil {
		t.Fatalf("expected span, got nil")
	}
	if span.Kind != cellChangeKindIns {
		t.Errorf("Kind: got %v want cellChangeKindIns", span.Kind)
	}
}

// TestQueueCellChangeAttrsDetectsDeletedSubcase confirms after.deleted=true
// flips Kind to cellChangeKindDel.
func TestQueueCellChangeAttrsDetectsDeletedSubcase(t *testing.T) {
	em := newEmitter()
	attrs := map[string]any{
		NodeAttrSuggestedBlockChange: map[string]any{
			"suggestionId": "s_cc_deleted",
			"authorId":     "uo_alice",
			"ts":           float64(1700000000000),
			"before": map[string]any{
				"type":  NodeTypeTableCell,
				"attrs": map[string]any{},
			},
			"after": map[string]any{
				"type":    NodeTypeTableCell,
				"attrs":   map[string]any{},
				"deleted": true,
			},
		},
	}
	span := em.queueCellChangeAttrs(attrs)
	if span == nil {
		t.Fatalf("expected span, got nil")
	}
	if span.Kind != cellChangeKindDel {
		t.Errorf("Kind: got %v want cellChangeKindDel", span.Kind)
	}
}

// TestQueueCellChangeAttrsIgnoresMissingAttr confirms the emitter is a
// no-op when the cell attrs don't carry the suggestedBlockChange key.
func TestQueueCellChangeAttrsIgnoresMissingAttr(t *testing.T) {
	em := newEmitter()
	span := em.queueCellChangeAttrs(map[string]any{"shading": "#FFFFFF"})
	if span != nil {
		t.Errorf("expected nil span on missing attr, got %+v", span)
	}
	if len(em.cellChangeSpans) != 0 {
		t.Errorf("emitter span queue should be empty, got %d", len(em.cellChangeSpans))
	}
}

// TestBuildCellChangeElementXMLAttr confirms the attr variant emits a
// <w:tcPrChange> wrapper with the BEFORE state nested inside.
func TestBuildCellChangeElementXMLAttr(t *testing.T) {
	span := cellChangeSpan{
		DocxRevisionID: 1,
		SuggestionID:   "s_cc_attr",
		AuthorID:       "uo_alice",
		Ts:             1700000000000,
		Kind:           cellChangeKindAttr,
		BeforeShading:  "#FFFF00",
	}
	got := buildCellChangeElementXML(span)
	for _, w := range []string{
		`<w:tcPrChange `,
		`w:id="1"`,
		`w:author="uo_alice"`,
		`w:date=`,
		`<w:tcPr>`,
		`<w:shd `,
		`w:fill="FFFF00"`,
		`</w:tcPr>`,
		`</w:tcPrChange>`,
	} {
		if !strings.Contains(got, w) {
			t.Errorf("missing %q in %q", w, got)
		}
	}
}

// TestBuildCellChangeElementXMLIns confirms the ins variant emits a
// self-closing <w:cellIns/> element.
func TestBuildCellChangeElementXMLIns(t *testing.T) {
	span := cellChangeSpan{
		DocxRevisionID: 2,
		SuggestionID:   "s_cc_ins",
		AuthorID:       "uo_alice",
		Ts:             1700000000000,
		Kind:           cellChangeKindIns,
	}
	got := buildCellChangeElementXML(span)
	for _, w := range []string{
		`<w:cellIns `,
		`w:id="2"`,
		`w:author="uo_alice"`,
		`w:date=`,
		`/>`,
	} {
		if !strings.Contains(got, w) {
			t.Errorf("missing %q in %q", w, got)
		}
	}
	if strings.Contains(got, "<w:tcPr>") {
		t.Errorf("cellIns should not contain nested tcPr; got %q", got)
	}
}

// TestBuildCellChangeElementXMLDel confirms the del variant emits a
// self-closing <w:cellDel/> element.
func TestBuildCellChangeElementXMLDel(t *testing.T) {
	span := cellChangeSpan{
		DocxRevisionID: 3,
		SuggestionID:   "s_cc_del",
		AuthorID:       "uo_alice",
		Ts:             1700000000000,
		Kind:           cellChangeKindDel,
	}
	got := buildCellChangeElementXML(span)
	for _, w := range []string{
		`<w:cellDel `,
		`w:id="3"`,
		`w:author="uo_alice"`,
		`/>`,
	} {
		if !strings.Contains(got, w) {
			t.Errorf("missing %q in %q", w, got)
		}
	}
}

// TestBuildCellChangeElementXMLOmitsDateWhenTsZero confirms a span with
// no ts produces an element without a w:date attribute.
func TestBuildCellChangeElementXMLOmitsDateWhenTsZero(t *testing.T) {
	span := cellChangeSpan{
		DocxRevisionID: 4,
		SuggestionID:   "s_cc_nodate",
		AuthorID:       "uo_alice",
		Ts:             0,
		Kind:           cellChangeKindIns,
	}
	got := buildCellChangeElementXML(span)
	if strings.Contains(got, "w:date=") {
		t.Errorf("expected no w:date attr, got %q", got)
	}
}

// TestWriteSuggestionsCustomXMLIncludesCellChange confirms a
// cellChangeSpan slice round-trips through the customXml part:
// writeSuggestionsCustomXML serializes it with kind="cellChange",
// and parseSuggestionsCustomXML re-populates the CellChange map.
func TestWriteSuggestionsCustomXMLIncludesCellChange(t *testing.T) {
	cellSpans := []cellChangeSpan{
		{DocxRevisionID: 1, SuggestionID: "s_cc_1", AuthorID: "uo_alice", Ts: 1700000000000, Kind: cellChangeKindAttr},
		{DocxRevisionID: 2, SuggestionID: "s_cc_2", AuthorID: "uo_bob", Ts: 1700000010000, Kind: cellChangeKindIns},
	}
	entries := []SuggestionMapEntry{
		{ID: "s_cc_1", AuthorID: "uo_alice", CreatedAt: 1700000000000, Status: "open"},
		{ID: "s_cc_2", AuthorID: "uo_bob", CreatedAt: 1700000010000, Status: "open"},
	}
	xmlBytes, err := writeSuggestionsCustomXML(nil, nil, nil, cellSpans, entries)
	if err != nil {
		t.Fatalf("write: %v", err)
	}
	xml := string(xmlBytes)
	if !strings.Contains(xml, `kind="cellChange"`) {
		t.Errorf("expected kind=cellChange in customXml; got:\n%s", xml)
	}

	_, parsed, err := parseSuggestionsCustomXML(xmlBytes)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got, ok := parsed.CellChange[1]; !ok || got != "s_cc_1" {
		t.Errorf("CellChange[1]: got %q (present=%v) want s_cc_1", got, ok)
	}
	if got, ok := parsed.CellChange[2]; !ok || got != "s_cc_2" {
		t.Errorf("CellChange[2]: got %q (present=%v) want s_cc_2", got, ok)
	}
}

// TestPMToDocxEmitsTcPrChangeForAttrOnlyChange covers the attr-only
// case: a tableCell whose suggestedBlockChange proposes a shading
// change. The output document.xml should contain <w:tcPrChange> with
// the BEFORE cell shading nested inside.
func TestPMToDocxEmitsTcPrChangeForAttrOnlyChange(t *testing.T) {
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
	docxBytes, _, err := PMJSONToDocxWithWarnings(pmJSON)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}
	docXML := string(extractDocumentXMLForSuggestionTest(t, docxBytes))
	if !strings.Contains(docXML, "<w:tcPrChange ") {
		t.Fatalf("expected <w:tcPrChange> in document.xml; got:\n%s", docXML)
	}
	if !strings.Contains(docXML, `w:author="uo_alice"`) {
		t.Errorf("expected w:author=uo_alice in tcPrChange; got:\n%s", docXML)
	}
	if !strings.Contains(docXML, `w:id="1"`) {
		t.Errorf("expected w:id=\"1\" in tcPrChange; got:\n%s", docXML)
	}
	// The marker text must be stripped.
	if strings.Contains(docXML, "{{__pmtcpr:") {
		t.Errorf("marker text leaked into document.xml: %s", docXML)
	}
}

// TestPMToDocxEmitsCellInsForAddedSubcase confirms the added sub-case
// produces a <w:cellIns> element (not <w:tcPrChange>).
func TestPMToDocxEmitsCellInsForAddedSubcase(t *testing.T) {
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
	docxBytes, _, err := PMJSONToDocxWithWarnings(pmJSON)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}
	docXML := string(extractDocumentXMLForSuggestionTest(t, docxBytes))
	if !strings.Contains(docXML, "<w:cellIns ") {
		t.Fatalf("expected <w:cellIns> in document.xml; got:\n%s", docXML)
	}
	if strings.Contains(docXML, "<w:tcPrChange ") {
		t.Errorf("added sub-case should emit cellIns, not tcPrChange: %s", docXML)
	}
}

// TestPMToDocxEmitsCellDelForDeletedSubcase confirms the deleted
// sub-case produces a <w:cellDel> element (not <w:tcPrChange>).
func TestPMToDocxEmitsCellDelForDeletedSubcase(t *testing.T) {
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
	docxBytes, _, err := PMJSONToDocxWithWarnings(pmJSON)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}
	docXML := string(extractDocumentXMLForSuggestionTest(t, docxBytes))
	if !strings.Contains(docXML, "<w:cellDel ") {
		t.Fatalf("expected <w:cellDel> in document.xml; got:\n%s", docXML)
	}
	if strings.Contains(docXML, "<w:tcPrChange ") {
		t.Errorf("deleted sub-case should emit cellDel, not tcPrChange: %s", docXML)
	}
}
