package translate

import (
	"strconv"
	"strings"
)

// blockChangeSpan tracks one PM suggestedBlockChange node attribute
// through the emitter so the post-process pass can splice a
// <w:pPrChange> wrapper into the paragraph's <w:pPr>. Mirrors
// formatChangeSpan in shape, but the anchor is a paragraph (not a run)
// and the spliced element sits inside <w:pPr> rather than <w:rPr>.
type blockChangeSpan struct {
	// DocxRevisionID is the w:id we'll write into <w:pPrChange>. Same
	// shape as suggestionSpan's DocxRevisionID — docx requires the
	// attribute be an unsigned integer and the customXml mapping is
	// keyed by it. The block-change kind has its own w:id sequence
	// (Word treats <w:ins>/<w:del>/<w:rPrChange>/<w:pPrChange> w:id
	// values as independent docx-local counters).
	DocxRevisionID int
	SuggestionID   string
	AuthorID       string
	// Ts is the unix-ms timestamp from the PM attr; converted to
	// ISO-8601 for the w:date attribute on emit.
	Ts int64
	// BeforeType / BeforeAttrs / AfterType / AfterAttrs describe the
	// pPr children that go in the nested <w:pPr> inside <w:pPrChange>
	// (BeforeType + BeforeAttrs) and what the outer pPr should look
	// like after WordZero finishes its native serialization
	// (AfterType + AfterAttrs — used for completeness on the span;
	// the outer pPr already reflects the AFTER state because the PM
	// node we walked carries the after-shape).
	BeforeType  string
	BeforeAttrs map[string]any
	AfterType   string
	AfterAttrs  map[string]any
	// IsDelete is set when the proposed change is a paragraph-level
	// deletion (after.deleted === true). The outer pPr stays as the
	// BEFORE state (no type/attr swap is applied) because the paragraph
	// is being deleted, not re-styled — only the marker indicating the
	// delete intent gets recorded. The inline content gets a
	// suggestedDelete mark via Phase 2c's path; this span exists so
	// the <w:pPrChange> wrapper records that the paragraph itself was
	// proposed for removal.
	IsDelete bool
	// Marker is the single placeholder text token planted as a bare run
	// inside the paragraph at emit time. The post-process pass uses the
	// marker to locate the enclosing <w:p>, walk back into its <w:pPr>
	// (or inject one if absent), and splice the <w:pPrChange> wrapper
	// at the end of the existing <w:pPr> children. Like the format-
	// change pattern, a single anchor is enough — the pPrChange wrapper
	// is a single XML splice into the paragraph's existing <w:pPr>,
	// not a wrapper spanning multiple paragraphs.
	Marker string
}

// blockChangeAnchorToken formats a unique marker text the rewriter
// recognises in document.xml. Numbered by em.blockChangeSpanSeq so
// each paragraph attribute gets its own anchor — same pattern as
// formatChangeOpenToken / codeOpenToken.
func blockChangeAnchorToken(n int) string {
	return "{{__pmppr:" + strconv.Itoa(n) + ":anchor}}"
}

// queueBlockChangeAttrs walks the given node attrs map and emits a
// blockChangeSpan if a `suggestedBlockChange` entry is present. Other
// attrs (textAlign, indent, level, etc.) are ignored. The emitter
// stamps a fresh DocxRevisionID and accumulates spans across the
// whole document walk.
//
// Returns the span pointer (or nil when no block-change attr is on
// the node) so the caller can emit the matching anchor marker into
// the paragraph stream. The span is also retained on the emitter
// (em.blockChangeSpans) for later serialization in postProcessRichXML
// and writeSuggestionsCustomXML.
func (em *emitter) queueBlockChangeAttrs(attrs map[string]any) *blockChangeSpan {
	raw, ok := attrs[NodeAttrSuggestedBlockChange]
	if !ok || raw == nil {
		return nil
	}
	payload, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	suggestionID, _ := payload["suggestionId"].(string)
	authorID, _ := payload["authorId"].(string)
	ts := unixMsFromAny(payload["ts"])

	beforeType, beforeAttrs := blockChangeStateFromAttr(payload["before"])
	afterType, afterAttrs := blockChangeStateFromAttr(payload["after"])
	isDelete := false
	if after, ok := payload["after"].(map[string]any); ok {
		if d, ok := after["deleted"].(bool); ok && d {
			isDelete = true
		}
	}

	em.blockChangeSpanSeq++
	span := blockChangeSpan{
		DocxRevisionID: em.blockChangeSpanSeq,
		SuggestionID:   suggestionID,
		AuthorID:       authorID,
		Ts:             ts,
		BeforeType:     beforeType,
		BeforeAttrs:    beforeAttrs,
		AfterType:      afterType,
		AfterAttrs:     afterAttrs,
		IsDelete:       isDelete,
		Marker:         blockChangeAnchorToken(em.blockChangeSpanSeq),
	}
	em.blockChangeSpans = append(em.blockChangeSpans, span)
	return &em.blockChangeSpans[len(em.blockChangeSpans)-1]
}

// blockChangeStateFromAttr unwraps a `before` / `after` attribute value
// (which arrived from JSON as a map[string]any with `type` + `attrs`
// keys plus optional `added` / `deleted` flags) into a (type, attrs)
// pair the pPr-children formatter can consume. Nil / wrong-shape input
// returns ("", nil) so the rewriter degrades gracefully (an empty
// nested <w:pPr> still validates and round-trips as "default
// paragraph properties").
func blockChangeStateFromAttr(v any) (string, map[string]any) {
	m, ok := v.(map[string]any)
	if !ok {
		return "", nil
	}
	t, _ := m["type"].(string)
	attrs, _ := m["attrs"].(map[string]any)
	if attrs == nil {
		attrs = map[string]any{}
	}
	return t, attrs
}

// blockStateToPPrChildren formats a (type, attrs) pair into the XML
// child elements that sit inside a docx <w:pPr> for a block of that
// type. Covers the v1 PM block surface — paragraph (default),
// heading (with level), bulletList / orderedList (numPr), blockquote
// (Quote pStyle) — plus textAlign + indent attrs.
//
// Empty type degrades to "no pStyle" (default Normal paragraph).
// Unknown types render only the textAlign + indent children — Word
// reads that as "a default paragraph with the proposed alignment /
// indent." Matches the silent-drop convention the format-change
// rewriter uses for unknown mark types.
func blockStateToPPrChildren(blockType string, attrs map[string]any) string {
	var sb strings.Builder
	// pStyle goes first — Word emits pStyle as the first child of pPr
	// and some readers are strict about the ordering.
	if style := pStyleForBlockType(blockType, attrs); style != "" {
		sb.WriteString(`<w:pStyle w:val="`)
		sb.WriteString(style)
		sb.WriteString(`"/>`)
	}
	// numPr (list numbering reference). Lists in our PM tree are
	// modeled as containers (bulletList / orderedList) wrapping
	// listItems wrapping paragraphs — so a "bulletList" or
	// "orderedList" in the before/after state typically represents a
	// transition from a non-list paragraph to a list item or vice
	// versa. We emit a placeholder numPr referencing numId=0 (Word's
	// "no numbering" sentinel) since the actual numId is allocated at
	// emit time per logical list — the BEFORE state's numId, if it
	// existed, is gone from the document by the time we're writing
	// the pPrChange. Accept/reject downstream re-derives the numId
	// from the surrounding paragraphs.
	if isListBlockType(blockType) {
		sb.WriteString(`<w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr>`)
	}
	if v, ok := attrs["textAlign"].(string); ok {
		if oox := pmAlignToOOXML(v); oox != "" {
			sb.WriteString(`<w:jc w:val="`)
			sb.WriteString(oox)
			sb.WriteString(`"/>`)
		}
	}
	if level := indentLevelFromAttrs(attrs); level > 0 {
		sb.WriteString(`<w:ind w:left="`)
		sb.WriteString(strconv.Itoa(level * twipsPerIndentLevel))
		sb.WriteString(`"/>`)
	}
	return sb.String()
}

// pStyleForBlockType returns the docx pStyle value Word expects for
// the given PM block type. paragraph → "" (default Normal style);
// heading with level=N → "HeadingN" (clamped to 1..6); blockquote →
// "Quote"; codeBlock → "CodeBlock". Lists are handled via numPr
// (see blockStateToPPrChildren) rather than pStyle.
//
// Unknown types return "" — the resulting pPr will carry only the
// textAlign / indent children. Matches the silent-drop convention.
func pStyleForBlockType(blockType string, attrs map[string]any) string {
	switch blockType {
	case NodeTypeHeading:
		level := 1
		if v, ok := attrs["level"].(float64); ok {
			level = int(v)
		} else if v, ok := attrs["level"].(int); ok {
			level = v
		}
		if level < 1 {
			level = 1
		}
		if level > 6 {
			level = 6
		}
		return "Heading" + strconv.Itoa(level)
	case NodeTypeBlockquote:
		return "Quote"
	case NodeTypeCodeBlock:
		return "CodeBlock"
	}
	return ""
}

// isListBlockType reports whether the given PM block type represents a
// list-item or list container. Used by blockStateToPPrChildren to decide
// whether to emit a placeholder <w:numPr> in the BEFORE / AFTER pPr.
func isListBlockType(blockType string) bool {
	switch blockType {
	case NodeTypeBulletList, NodeTypeOrderedList, NodeTypeListItem:
		return true
	}
	return false
}
