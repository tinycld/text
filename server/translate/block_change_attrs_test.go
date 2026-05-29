package translate

import (
	"strings"
	"testing"
)

// TestQueueBlockChangeAttrsProducesOneSpanPerNode confirms the
// emitter records a blockChangeSpan when a node carries a
// suggestedBlockChange attribute and synthesizes a fresh
// DocxRevisionID + marker token for each one.
func TestQueueBlockChangeAttrsProducesOneSpanPerNode(t *testing.T) {
	em := newEmitter()
	attrs := map[string]any{
		NodeAttrSuggestedBlockChange: map[string]any{
			"suggestionId": "s_bc_1",
			"authorId":     "uo_alice",
			"ts":           float64(1700000000000),
			"before": map[string]any{
				"type":  NodeTypeParagraph,
				"attrs": map[string]any{},
			},
			"after": map[string]any{
				"type":  NodeTypeHeading,
				"attrs": map[string]any{"level": float64(2)},
			},
		},
	}
	span := em.queueBlockChangeAttrs(attrs)
	if span == nil {
		t.Fatalf("expected span, got nil")
	}
	if span.SuggestionID != "s_bc_1" {
		t.Errorf("suggestionId: got %q want %q", span.SuggestionID, "s_bc_1")
	}
	if span.AuthorID != "uo_alice" {
		t.Errorf("authorId: got %q want %q", span.AuthorID, "uo_alice")
	}
	if span.Ts != 1700000000000 {
		t.Errorf("ts: got %d want %d", span.Ts, 1700000000000)
	}
	if span.DocxRevisionID != 1 {
		t.Errorf("DocxRevisionID: got %d want 1", span.DocxRevisionID)
	}
	if span.BeforeType != NodeTypeParagraph {
		t.Errorf("BeforeType: got %q want %q", span.BeforeType, NodeTypeParagraph)
	}
	if span.AfterType != NodeTypeHeading {
		t.Errorf("AfterType: got %q want %q", span.AfterType, NodeTypeHeading)
	}
	if !strings.HasPrefix(span.Marker, "{{__pmppr:") {
		t.Errorf("Marker token: got %q want prefix {{__pmppr:", span.Marker)
	}
	if len(em.blockChangeSpans) != 1 {
		t.Errorf("emitter span queue: got %d want 1", len(em.blockChangeSpans))
	}
}

// TestQueueBlockChangeAttrsIgnoresMissingAttr confirms the emitter is
// a no-op when the node attrs don't carry the suggestedBlockChange
// key.
func TestQueueBlockChangeAttrsIgnoresMissingAttr(t *testing.T) {
	em := newEmitter()
	span := em.queueBlockChangeAttrs(map[string]any{"textAlign": "center"})
	if span != nil {
		t.Errorf("expected nil span on missing attr, got %+v", span)
	}
	if len(em.blockChangeSpans) != 0 {
		t.Errorf("emitter span queue should be empty, got %d", len(em.blockChangeSpans))
	}
}

// TestQueueBlockChangeAttrsDetectsDeleteSubcase confirms the IsDelete
// flag flips when after.deleted === true.
func TestQueueBlockChangeAttrsDetectsDeleteSubcase(t *testing.T) {
	em := newEmitter()
	attrs := map[string]any{
		NodeAttrSuggestedBlockChange: map[string]any{
			"suggestionId": "s_bc_del",
			"authorId":     "uo_alice",
			"ts":           float64(1700000000000),
			"before": map[string]any{
				"type":  NodeTypeParagraph,
				"attrs": map[string]any{},
			},
			"after": map[string]any{
				"type":    NodeTypeParagraph,
				"attrs":   map[string]any{},
				"deleted": true,
			},
		},
	}
	span := em.queueBlockChangeAttrs(attrs)
	if span == nil {
		t.Fatalf("expected span, got nil")
	}
	if !span.IsDelete {
		t.Errorf("IsDelete: got false, want true (after.deleted=true)")
	}
}

// TestBlockStateToPPrChildrenCoversCommonShapes confirms each sub-case
// (paragraph default, heading level, alignment, indent, blockquote
// pStyle) renders to the expected docx pPr children.
func TestBlockStateToPPrChildrenCoversCommonShapes(t *testing.T) {
	cases := []struct {
		name  string
		typ   string
		attrs map[string]any
		want  []string
	}{
		{
			name:  "default paragraph emits no pStyle",
			typ:   NodeTypeParagraph,
			attrs: map[string]any{},
			want:  []string{},
		},
		{
			name:  "heading level 2",
			typ:   NodeTypeHeading,
			attrs: map[string]any{"level": float64(2)},
			want:  []string{`<w:pStyle w:val="Heading2"/>`},
		},
		{
			name:  "heading level 6",
			typ:   NodeTypeHeading,
			attrs: map[string]any{"level": float64(6)},
			want:  []string{`<w:pStyle w:val="Heading6"/>`},
		},
		{
			name:  "blockquote",
			typ:   NodeTypeBlockquote,
			attrs: map[string]any{},
			want:  []string{`<w:pStyle w:val="Quote"/>`},
		},
		{
			name:  "codeBlock",
			typ:   NodeTypeCodeBlock,
			attrs: map[string]any{},
			want:  []string{`<w:pStyle w:val="CodeBlock"/>`},
		},
		{
			name:  "paragraph with center alignment",
			typ:   NodeTypeParagraph,
			attrs: map[string]any{"textAlign": "center"},
			want:  []string{`<w:jc w:val="center"/>`},
		},
		{
			name:  "paragraph with indent",
			typ:   NodeTypeParagraph,
			attrs: map[string]any{"indent": float64(2)},
			want:  []string{`<w:ind w:left="1440"/>`}, // 2 * 720
		},
		{
			name:  "heading with align+indent",
			typ:   NodeTypeHeading,
			attrs: map[string]any{"level": float64(3), "textAlign": "right", "indent": float64(1)},
			want: []string{
				`<w:pStyle w:val="Heading3"/>`,
				`<w:jc w:val="right"/>`,
				`<w:ind w:left="720"/>`,
			},
		},
		{
			name:  "bulletList emits numPr placeholder",
			typ:   NodeTypeBulletList,
			attrs: map[string]any{},
			want:  []string{`<w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr>`},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := blockStateToPPrChildren(tc.typ, tc.attrs)
			for _, w := range tc.want {
				if !strings.Contains(got, w) {
					t.Errorf("missing %q in pPr children %q", w, got)
				}
			}
			if len(tc.want) == 0 && got != "" {
				t.Errorf("expected empty pPr children, got %q", got)
			}
		})
	}
}

// TestBuildPPrChangeXMLContainsBeforeNestedPPr confirms the emitted
// <w:pPrChange> wraps a nested <w:pPr> with the BEFORE state, and
// carries the w:id/w:author/w:date attributes.
func TestBuildPPrChangeXMLContainsBeforeNestedPPr(t *testing.T) {
	span := blockChangeSpan{
		DocxRevisionID: 7,
		SuggestionID:   "s_bc_7",
		AuthorID:       "uo_alice",
		Ts:             1700000000000,
		BeforeType:     NodeTypeParagraph,
		BeforeAttrs:    map[string]any{},
		AfterType:      NodeTypeHeading,
		AfterAttrs:     map[string]any{"level": float64(2)},
	}
	got := buildPPrChangeXML(span)
	for _, w := range []string{
		`<w:pPrChange `,
		`w:id="7"`,
		`w:author="uo_alice"`,
		`w:date=`,
		`<w:pPr></w:pPr>`, // empty BEFORE state — default paragraph
		`</w:pPrChange>`,
	} {
		if !strings.Contains(got, w) {
			t.Errorf("missing %q in %q", w, got)
		}
	}
}

// TestBuildPPrChangeXMLOmitsDateWhenTsZero confirms a span with no ts
// produces a <w:pPrChange> without a w:date attribute (matching the
// emit convention for <w:ins>/<w:del>/<w:rPrChange>).
func TestBuildPPrChangeXMLOmitsDateWhenTsZero(t *testing.T) {
	span := blockChangeSpan{
		DocxRevisionID: 3,
		SuggestionID:   "s_bc_3",
		AuthorID:       "uo_alice",
		Ts:             0,
		BeforeType:     NodeTypeParagraph,
		BeforeAttrs:    map[string]any{},
	}
	got := buildPPrChangeXML(span)
	if strings.Contains(got, "w:date=") {
		t.Errorf("expected no w:date attr, got %q", got)
	}
}

// TestBuildPPrChangeXMLBeforeStateHasHeadingPStyle covers the
// realistic case where BEFORE is a heading and AFTER is a paragraph
// (a "demote heading to paragraph" proposal). The nested pPr inside
// pPrChange must carry the heading's pStyle.
func TestBuildPPrChangeXMLBeforeStateHasHeadingPStyle(t *testing.T) {
	span := blockChangeSpan{
		DocxRevisionID: 11,
		SuggestionID:   "s_bc_demote",
		AuthorID:       "uo_alice",
		Ts:             1700000000000,
		BeforeType:     NodeTypeHeading,
		BeforeAttrs:    map[string]any{"level": float64(2)},
		AfterType:      NodeTypeParagraph,
		AfterAttrs:     map[string]any{},
	}
	got := buildPPrChangeXML(span)
	if !strings.Contains(got, `<w:pPr><w:pStyle w:val="Heading2"/></w:pPr>`) {
		t.Errorf("expected nested BEFORE pPr to carry Heading2 pStyle, got %q", got)
	}
}

// TestWriteSuggestionsCustomXMLIncludesBlockChange confirms that a
// blockChangeSpan slice round-trips through the customXml part:
// writeSuggestionsCustomXML serializes it with kind="blockChange",
// and parseSuggestionsCustomXML re-populates the BlockChange map.
func TestWriteSuggestionsCustomXMLIncludesBlockChange(t *testing.T) {
	blockSpans := []blockChangeSpan{
		{DocxRevisionID: 1, SuggestionID: "s_bc_1", AuthorID: "uo_alice", Ts: 1700000000000},
		{DocxRevisionID: 2, SuggestionID: "s_bc_2", AuthorID: "uo_bob", Ts: 1700000010000},
	}
	entries := []SuggestionMapEntry{
		{ID: "s_bc_1", AuthorID: "uo_alice", CreatedAt: 1700000000000, Status: "open"},
		{ID: "s_bc_2", AuthorID: "uo_bob", CreatedAt: 1700000010000, Status: "open"},
	}
	xmlBytes, err := writeSuggestionsCustomXML(nil, nil, blockSpans, entries)
	if err != nil {
		t.Fatalf("write: %v", err)
	}
	xml := string(xmlBytes)
	if !strings.Contains(xml, `kind="blockChange"`) {
		t.Errorf("expected kind=blockChange in customXml; got:\n%s", xml)
	}

	_, parsed, err := parseSuggestionsCustomXML(xmlBytes)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got, ok := parsed.BlockChange[1]; !ok || got != "s_bc_1" {
		t.Errorf("BlockChange[1]: got %q (present=%v) want s_bc_1", got, ok)
	}
	if got, ok := parsed.BlockChange[2]; !ok || got != "s_bc_2" {
		t.Errorf("BlockChange[2]: got %q (present=%v) want s_bc_2", got, ok)
	}
	// Insert/Delete must NOT be populated by blockChange entries — they
	// have independent w:id sequences.
	if _, ok := parsed.Insert[1]; ok {
		t.Errorf("Insert[1] should not be set by blockChange entry")
	}
}

// TestPMToDocxEmitsWPPrChangeForAttrOnlyChange covers the attr-only
// case: a paragraph whose suggestedBlockChange swaps it to a heading.
// The output document.xml should contain <w:pPrChange> with the
// BEFORE paragraph pPr nested inside and the AFTER heading pStyle on
// the outer pPr.
func TestPMToDocxEmitsWPPrChangeForAttrOnlyChange(t *testing.T) {
	pmJSON := []byte(`{
		"type": "doc",
		"content": [{
			"type": "heading",
			"attrs": {
				"level": 2,
				"suggestedBlockChange": {
					"suggestionId": "s_bc_h2",
					"authorId": "uo_alice",
					"ts": 1700000000000,
					"before": {"type": "paragraph", "attrs": {}},
					"after": {"type": "heading", "attrs": {"level": 2}}
				}
			},
			"content": [{"type": "text", "text": "Promoted Heading"}]
		}]
	}`)
	docxBytes, _, err := PMJSONToDocxWithWarnings(pmJSON)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}
	docXML := string(extractDocumentXMLForSuggestionTest(t, docxBytes))
	if !strings.Contains(docXML, "<w:pPrChange ") {
		t.Fatalf("expected <w:pPrChange> in document.xml; got:\n%s", docXML)
	}
	if !strings.Contains(docXML, `w:author="uo_alice"`) {
		t.Errorf("expected w:author=uo_alice in pPrChange; got:\n%s", docXML)
	}
	if !strings.Contains(docXML, `w:id="1"`) {
		t.Errorf("expected w:id=\"1\" in pPrChange; got:\n%s", docXML)
	}
	// The marker text must be stripped.
	if strings.Contains(docXML, "{{__pmppr:") {
		t.Errorf("marker text leaked into document.xml: %s", docXML)
	}
	// AFTER state — the heading's outer pPr should carry pStyle=Heading2
	// (WordZero emits this when AddHeadingParagraph is called).
	// WordZero may emit either <w:pStyle .../> or <w:pStyle ...></w:pStyle>.
	if !strings.Contains(docXML, `<w:pStyle w:val="Heading2"/>`) &&
		!strings.Contains(docXML, `<w:pStyle w:val="Heading2"></w:pStyle>`) {
		t.Errorf("expected outer Heading2 pStyle; got:\n%s", docXML)
	}
}
