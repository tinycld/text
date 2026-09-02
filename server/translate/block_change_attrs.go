package translate

import (
	"strconv"

	"github.com/nathanstitt/omnidoc/pkg/docx"
)

// blockChangeSpan tracks one PM suggestedBlockChange node attribute through the
// builder so the customXml part records the (w:id -> suggestionId) mapping, and
// so the paragraph's PPrChange.Previous can be built from the before-state.
type blockChangeSpan struct {
	// DocxRevisionID is the w:id written into <w:pPrChange>; the customXml
	// mapping is keyed by it. Independent counter from the other span kinds.
	DocxRevisionID int
	SuggestionID   string
	AuthorID       string
	// Ts is the unix-ms timestamp from the PM attr; ISO-8601 for w:date.
	Ts int64
	// BeforeType / BeforeAttrs describe the before-state paragraph, encoded
	// into PPrChange.Previous; the outer pPr already reflects the after shape.
	BeforeType  string
	BeforeAttrs map[string]any
	AfterType   string
	AfterAttrs  map[string]any
	// IsDelete is set for a paragraph-level deletion (after.deleted). The outer
	// pPr keeps the after shape; the inline content carries a suggestedDelete.
	IsDelete bool
}

// queueBlockChangeAttrs emits a blockChangeSpan when a suggestedBlockChange
// attr is present on the node. Returns the span pointer (or nil), stamping a
// fresh DocxRevisionID and accumulating spans for customXml serialization.
func (b *builder) queueBlockChangeAttrs(attrs map[string]any) *blockChangeSpan {
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

	b.blockChangeSeq++
	span := blockChangeSpan{
		DocxRevisionID: b.blockChangeSeq,
		SuggestionID:   suggestionID,
		AuthorID:       authorID,
		Ts:             ts,
		BeforeType:     beforeType,
		BeforeAttrs:    beforeAttrs,
		AfterType:      afterType,
		AfterAttrs:     afterAttrs,
		IsDelete:       isDelete,
	}
	b.blockChangeSpans = append(b.blockChangeSpans, span)
	return &b.blockChangeSpans[len(b.blockChangeSpans)-1]
}

// blockChangeStateFromAttr unwraps a `before` / `after` attribute value into a
// (type, attrs) pair. Nil / wrong-shape input returns ("", nil).
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

// blockStateToParagraphProps builds the before-state docx.ParagraphProps that
// sits inside <w:pPrChange> from a (type, attrs) pair. Covers the v1 block
// surface: paragraph (default), heading (HeadingN), blockquote (Quote),
// codeBlock (CodeBlock), lists (a placeholder numPr referencing numId 0, since
// the real numId is allocated per logical list and gone by write time), plus
// textAlign + indent.
func blockStateToParagraphProps(blockType string, attrs map[string]any) docx.ParagraphProps {
	var p docx.ParagraphProps
	if style := pStyleForBlockType(blockType, attrs); style != "" {
		p.StyleID = style
	}
	if isListBlockType(blockType) {
		// A numId=0 placeholder — Word's "no numbering" sentinel. The importer
		// reads it back as a list (bulletList) block-type proxy; the actual
		// numId is re-derived from surrounding paragraphs on accept/reject.
		p.HasNum = true
		p.NumID = 0
		p.ILvl = 0
	}
	if v, ok := attrs["textAlign"].(string); ok {
		if jc, has := pmAlignToJustify(v); has {
			p.Justify, p.HasJustify = jc, true
		}
	}
	if level := indentLevelFromAttrs(attrs); level > 0 {
		p.IndentLeft = docx.Twips(level * twipsPerIndentLevel)
		p.HasIndentLeft = true
	}
	return p
}

// pStyleForBlockType returns the docx pStyle for a PM block type. paragraph ->
// "" (Normal); heading level N -> "HeadingN" (clamped 1..6); blockquote ->
// "Quote"; codeBlock -> "CodeBlock". Lists ride numPr, not pStyle.
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

// isListBlockType reports whether the given PM block type is a list-item /
// list container. Used to decide whether to emit a placeholder numPr.
func isListBlockType(blockType string) bool {
	switch blockType {
	case NodeTypeBulletList, NodeTypeOrderedList, NodeTypeListItem:
		return true
	}
	return false
}
