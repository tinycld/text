package translate

import (
	"strings"
	"testing"

	"github.com/nathanstitt/doctaculous/pkg/docx"
)

// TestQueueBlockChangeAttrsProducesOneSpanPerNode confirms the
// emitter records a blockChangeSpan when a node carries a
// suggestedBlockChange attribute and synthesizes a fresh
// DocxRevisionID + marker token for each one.
func TestQueueBlockChangeAttrsProducesOneSpanPerNode(t *testing.T) {
	b := newBuilder()
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
	span := b.queueBlockChangeAttrs(attrs)
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
	if len(b.blockChangeSpans) != 1 {
		t.Errorf("builder span queue: got %d want 1", len(b.blockChangeSpans))
	}
}

// TestQueueBlockChangeAttrsIgnoresMissingAttr confirms the emitter is
// a no-op when the node attrs don't carry the suggestedBlockChange
// key.
func TestQueueBlockChangeAttrsIgnoresMissingAttr(t *testing.T) {
	b := newBuilder()
	span := b.queueBlockChangeAttrs(map[string]any{"textAlign": "center"})
	if span != nil {
		t.Errorf("expected nil span on missing attr, got %+v", span)
	}
	if len(b.blockChangeSpans) != 0 {
		t.Errorf("builder span queue should be empty, got %d", len(b.blockChangeSpans))
	}
}

// TestQueueBlockChangeAttrsDetectsDeleteSubcase confirms the IsDelete
// flag flips when after.deleted === true.
func TestQueueBlockChangeAttrsDetectsDeleteSubcase(t *testing.T) {
	b := newBuilder()
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
	span := b.queueBlockChangeAttrs(attrs)
	if span == nil {
		t.Fatalf("expected span, got nil")
	}
	if !span.IsDelete {
		t.Errorf("IsDelete: got false, want true (after.deleted=true)")
	}
}

// TestBlockStateToParagraphPropsCoversCommonShapes confirms each sub-case
// (paragraph default, heading level, alignment, indent, blockquote,
// codeBlock, list numPr placeholder) maps to the expected ParagraphProps
// fields — the model-based replacement for the old pPr-children XML builder.
func TestBlockStateToParagraphPropsCoversCommonShapes(t *testing.T) {
	cases := []struct {
		name  string
		typ   string
		attrs map[string]any
		check func(t *testing.T, p docx.ParagraphProps)
	}{
		{
			name: "default paragraph emits no style", typ: NodeTypeParagraph, attrs: map[string]any{},
			check: func(t *testing.T, p docx.ParagraphProps) {
				if p.StyleID != "" || p.HasJustify || p.HasIndentLeft || p.HasNum {
					t.Errorf("expected empty props, got %+v", p)
				}
			},
		},
		{
			name: "heading level 2", typ: NodeTypeHeading, attrs: map[string]any{"level": float64(2)},
			check: func(t *testing.T, p docx.ParagraphProps) {
				if p.StyleID != "Heading2" {
					t.Errorf("StyleID: got %q want Heading2", p.StyleID)
				}
			},
		},
		{
			name: "heading level 6", typ: NodeTypeHeading, attrs: map[string]any{"level": float64(6)},
			check: func(t *testing.T, p docx.ParagraphProps) {
				if p.StyleID != "Heading6" {
					t.Errorf("StyleID: got %q want Heading6", p.StyleID)
				}
			},
		},
		{
			name: "blockquote", typ: NodeTypeBlockquote, attrs: map[string]any{},
			check: func(t *testing.T, p docx.ParagraphProps) {
				if p.StyleID != "Quote" {
					t.Errorf("StyleID: got %q want Quote", p.StyleID)
				}
			},
		},
		{
			name: "codeBlock", typ: NodeTypeCodeBlock, attrs: map[string]any{},
			check: func(t *testing.T, p docx.ParagraphProps) {
				if p.StyleID != "CodeBlock" {
					t.Errorf("StyleID: got %q want CodeBlock", p.StyleID)
				}
			},
		},
		{
			name: "paragraph center alignment", typ: NodeTypeParagraph, attrs: map[string]any{"textAlign": "center"},
			check: func(t *testing.T, p docx.ParagraphProps) {
				if !p.HasJustify || p.Justify != docx.JustifyCenter {
					t.Errorf("expected center justify, got %+v", p)
				}
			},
		},
		{
			name: "paragraph indent", typ: NodeTypeParagraph, attrs: map[string]any{"indent": float64(2)},
			check: func(t *testing.T, p docx.ParagraphProps) {
				if !p.HasIndentLeft || p.IndentLeft != 1440 { // 2 * 720
					t.Errorf("expected indentLeft 1440, got %+v", p)
				}
			},
		},
		{
			name: "bulletList emits numPr placeholder", typ: NodeTypeBulletList, attrs: map[string]any{},
			check: func(t *testing.T, p docx.ParagraphProps) {
				if !p.HasNum || p.NumID != 0 || p.ILvl != 0 {
					t.Errorf("expected numPr placeholder (numId 0), got %+v", p)
				}
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tc.check(t, blockStateToParagraphProps(tc.typ, tc.attrs))
		})
	}
}

// TestBlockChangeFromAttrsBuildsParaPropsChange confirms blockChangeFromAttrs
// produces a ParaPropsChange whose mark carries the id/author/date and whose
// Previous state reflects the before-shape (empty for a paragraph before).
func TestBlockChangeFromAttrsBuildsParaPropsChange(t *testing.T) {
	b := newBuilder()
	attrs := map[string]any{
		NodeAttrSuggestedBlockChange: map[string]any{
			"suggestionId": "s_bc_7",
			"authorId":     "uo_alice",
			"ts":           float64(1700000000000),
			"before":       map[string]any{"type": NodeTypeParagraph, "attrs": map[string]any{}},
			"after":        map[string]any{"type": NodeTypeHeading, "attrs": map[string]any{"level": float64(2)}},
		},
	}
	change := b.blockChangeFromAttrs(attrs)
	if change == nil {
		t.Fatalf("expected a ParaPropsChange, got nil")
	}
	if change.Mark.ID != 1 {
		t.Errorf("Mark.ID: got %d want 1", change.Mark.ID)
	}
	if change.Mark.Author != "uo_alice" {
		t.Errorf("Mark.Author: got %q want uo_alice", change.Mark.Author)
	}
	if change.Mark.Date == "" {
		t.Errorf("expected a non-empty w:date for a non-zero ts")
	}
	// A paragraph before-state carries no style.
	if change.Previous.StyleID != "" {
		t.Errorf("Previous.StyleID: got %q want empty (default paragraph)", change.Previous.StyleID)
	}
}

// TestBlockChangeFromAttrsOmitsDateWhenTsZero confirms a zero ts yields no
// w:date (an empty Mark.Date), matching the ins/del/rPrChange convention.
func TestBlockChangeFromAttrsOmitsDateWhenTsZero(t *testing.T) {
	b := newBuilder()
	attrs := map[string]any{
		NodeAttrSuggestedBlockChange: map[string]any{
			"suggestionId": "s_bc_3",
			"authorId":     "uo_alice",
			"ts":           float64(0),
			"before":       map[string]any{"type": NodeTypeParagraph, "attrs": map[string]any{}},
		},
	}
	change := b.blockChangeFromAttrs(attrs)
	if change == nil {
		t.Fatalf("expected a ParaPropsChange, got nil")
	}
	if change.Mark.Date != "" {
		t.Errorf("expected empty Mark.Date for ts=0, got %q", change.Mark.Date)
	}
}

// TestBlockChangeFromAttrsBeforeStateHasHeadingStyle covers a "demote heading
// to paragraph" proposal: the Previous state must carry the heading pStyle.
func TestBlockChangeFromAttrsBeforeStateHasHeadingStyle(t *testing.T) {
	b := newBuilder()
	attrs := map[string]any{
		NodeAttrSuggestedBlockChange: map[string]any{
			"suggestionId": "s_bc_demote",
			"authorId":     "uo_alice",
			"ts":           float64(1700000000000),
			"before":       map[string]any{"type": NodeTypeHeading, "attrs": map[string]any{"level": float64(2)}},
			"after":        map[string]any{"type": NodeTypeParagraph, "attrs": map[string]any{}},
		},
	}
	change := b.blockChangeFromAttrs(attrs)
	if change == nil {
		t.Fatalf("expected a ParaPropsChange, got nil")
	}
	if change.Previous.StyleID != "Heading2" {
		t.Errorf("Previous.StyleID: got %q want Heading2", change.Previous.StyleID)
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
	xmlBytes, err := writeSuggestionsCustomXML(nil, nil, blockSpans, nil, entries)
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
	// AFTER state — the heading's outer pPr should carry pStyle=Heading2.
	if !strings.Contains(docXML, `<w:pStyle w:val="Heading2"/>`) &&
		!strings.Contains(docXML, `<w:pStyle w:val="Heading2"></w:pStyle>`) {
		t.Errorf("expected outer Heading2 pStyle; got:\n%s", docXML)
	}
}
