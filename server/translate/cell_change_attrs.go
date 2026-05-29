package translate

import (
	"strconv"
)

// cellChangeSpan tracks one PM suggestedBlockChange node attribute
// that landed on a tableCell / tableHeader node through the emitter
// so the post-process pass can splice a <w:tcPrChange> /
// <w:cellIns> / <w:cellDel> element into the cell's <w:tcPr>.
//
// Mirrors blockChangeSpan in shape — the anchor is one cell (not a
// paragraph) and the spliced element sits inside <w:tcPr> rather
// than <w:pPr>. Same independent-counter rule for DocxRevisionID:
// <w:tcPrChange> / <w:cellIns> / <w:cellDel> each have their own
// w:id sequence inside docx, but we treat all three as one "cell
// change" kind on our side since they all derive from the same
// PM suggestedBlockChange-on-a-cell shape.
type cellChangeSpan struct {
	// DocxRevisionID is the w:id we'll write into the cell-change
	// element. Independent counter from suggestionSpan,
	// formatChangeSpan, and blockChangeSpan — Word treats each
	// rev-kind's w:id values as separate sequences.
	DocxRevisionID int
	SuggestionID   string
	AuthorID       string
	// Ts is the unix-ms timestamp from the PM attr; converted to
	// ISO-8601 for the w:date attribute on emit.
	Ts int64
	// Kind selects which element to splice. cellChangeKindAttr is
	// the common case (cell properties changed); cellChangeKindIns
	// records that the cell was proposed for addition; cellChangeKindDel
	// records it was proposed for removal.
	Kind cellChangeKind
	// BeforeShading / BeforeBorders capture the cell's BEFORE-state
	// properties that go inside the nested <w:tcPr> of <w:tcPrChange>.
	// Only populated for cellChangeKindAttr — the ins/del variants
	// don't have a meaningful "before properties" payload (the cell
	// either didn't exist or is being deleted entirely).
	BeforeShading string
	BeforeBorders map[string]any
	// Marker is the single placeholder text token planted as a bare
	// run inside the cell's first paragraph at emit time. The
	// post-process pass uses the marker to locate the enclosing
	// <w:tc>, walk back into its <w:tcPr> (or inject one if absent),
	// and splice the cell-change element at the end of the existing
	// <w:tcPr> children.
	Marker string
}

// cellChangeKind selects the docx element variant to emit.
type cellChangeKind int

const (
	// cellChangeKindAttr — standard cell-properties change. Emits
	// <w:tcPrChange> with nested BEFORE <w:tcPr>.
	cellChangeKindAttr cellChangeKind = iota
	// cellChangeKindIns — cell proposed for addition. Emits
	// <w:cellIns> as a child of the cell's <w:tcPr>. The cell
	// content stays in the document; the marker records the intent.
	cellChangeKindIns
	// cellChangeKindDel — cell proposed for deletion. Emits
	// <w:cellDel> as a child of the cell's <w:tcPr>. Same as ins:
	// the cell content stays in the doc until the suggestion is
	// resolved.
	cellChangeKindDel
)

// cellChangeAnchorToken formats a unique marker text the rewriter
// recognises in document.xml. Numbered by em.cellChangeSpanSeq so
// each cell attribute gets its own anchor — same pattern as
// blockChangeAnchorToken / formatChangeOpenToken.
func cellChangeAnchorToken(n int) string {
	return "{{__pmtcpr:" + strconv.Itoa(n) + ":anchor}}"
}

// queueCellChangeAttrs walks the given cell-node attrs map and emits
// a cellChangeSpan if a `suggestedBlockChange` entry is present. The
// before.added / after.deleted flags select cellChangeKindIns /
// cellChangeKindDel respectively; otherwise we emit cellChangeKindAttr.
//
// Returns the span pointer (or nil when no change is on the cell)
// so the caller can emit the matching anchor marker into the cell's
// first paragraph. The span is also retained on the emitter for
// later serialization in postProcessRichXML and
// writeSuggestionsCustomXML.
func (em *emitter) queueCellChangeAttrs(attrs map[string]any) *cellChangeSpan {
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

	kind := cellChangeKindAttr
	if before, ok := payload["before"].(map[string]any); ok {
		if added, ok := before["added"].(bool); ok && added {
			kind = cellChangeKindIns
		}
	}
	if after, ok := payload["after"].(map[string]any); ok {
		if d, ok := after["deleted"].(bool); ok && d {
			kind = cellChangeKindDel
		}
	}

	// Pull BEFORE-state cell properties for the attr case. The ins/del
	// variants don't carry meaningful BEFORE state.
	var beforeShading string
	var beforeBorders map[string]any
	if kind == cellChangeKindAttr {
		if before, ok := payload["before"].(map[string]any); ok {
			if beforeAttrs, ok := before["attrs"].(map[string]any); ok {
				if s, ok := beforeAttrs["shading"].(string); ok {
					beforeShading = s
				}
				if b, ok := beforeAttrs["borders"].(map[string]any); ok {
					beforeBorders = b
				}
			}
		}
	}

	em.cellChangeSpanSeq++
	span := cellChangeSpan{
		DocxRevisionID: em.cellChangeSpanSeq,
		SuggestionID:   suggestionID,
		AuthorID:       authorID,
		Ts:             ts,
		Kind:           kind,
		BeforeShading:  beforeShading,
		BeforeBorders:  beforeBorders,
		Marker:         cellChangeAnchorToken(em.cellChangeSpanSeq),
	}
	em.cellChangeSpans = append(em.cellChangeSpans, span)
	return &em.cellChangeSpans[len(em.cellChangeSpans)-1]
}
