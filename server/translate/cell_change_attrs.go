package translate

import (
	"github.com/nathanstitt/omnidoc/pkg/docx"
)

// cellChangeSpan tracks one PM suggestedBlockChange node attribute that landed
// on a tableCell / tableHeader through the builder so the customXml part
// records the (w:id -> suggestionId) mapping, and so the cell's TcPrChange /
// Ins / Del can be built.
type cellChangeSpan struct {
	// DocxRevisionID is the w:id written into the cell-change element; the
	// customXml mapping is keyed by it. Independent counter from the other
	// span kinds.
	DocxRevisionID int
	SuggestionID   string
	AuthorID       string
	// Ts is the unix-ms timestamp from the PM attr; ISO-8601 for w:date.
	Ts int64
	// Kind selects which element to emit (attr change / ins / del).
	Kind cellChangeKind
	// BeforeShading / BeforeBorders are the before-state properties inside the
	// nested tcPr of <w:tcPrChange>. Only populated for the attr case.
	BeforeShading string
	BeforeBorders map[string]any
}

// cellChangeKind selects the docx element variant to emit.
type cellChangeKind int

const (
	// cellChangeKindAttr — standard cell-properties change (<w:tcPrChange>).
	cellChangeKindAttr cellChangeKind = iota
	// cellChangeKindIns — cell proposed for addition (<w:cellIns>).
	cellChangeKindIns
	// cellChangeKindDel — cell proposed for deletion (<w:cellDel>).
	cellChangeKindDel
)

// queueCellChangeAttrs emits a cellChangeSpan when a suggestedBlockChange attr
// is present on a cell. Returns the span pointer (or nil), stamping a fresh
// DocxRevisionID and accumulating spans for customXml serialization.
func (b *builder) queueCellChangeAttrs(attrs map[string]any) *cellChangeSpan {
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

	var beforeShading string
	var beforeBorders map[string]any
	if kind == cellChangeKindAttr {
		if before, ok := payload["before"].(map[string]any); ok {
			if beforeAttrs, ok := before["attrs"].(map[string]any); ok {
				if s, ok := beforeAttrs["shading"].(string); ok {
					beforeShading = s
				}
				if bd, ok := beforeAttrs["borders"].(map[string]any); ok {
					beforeBorders = bd
				}
			}
		}
	}

	b.cellChangeSeq++
	span := cellChangeSpan{
		DocxRevisionID: b.cellChangeSeq,
		SuggestionID:   suggestionID,
		AuthorID:       authorID,
		Ts:             ts,
		Kind:           kind,
		BeforeShading:  beforeShading,
		BeforeBorders:  beforeBorders,
	}
	b.cellChangeSpans = append(b.cellChangeSpans, span)
	return &b.cellChangeSpans[len(b.cellChangeSpans)-1]
}

// applyCellChange stamps the cell-change span onto a docx.TableCell: an ins/del
// RevisionMark, or a TcPrChange carrying the before-state properties.
func (span *cellChangeSpan) applyCellChange(cell *docx.TableCell) {
	mark := docx.RevisionMark{ID: span.DocxRevisionID, Author: span.AuthorID, Date: unixMsToISO8601(span.Ts)}
	switch span.Kind {
	case cellChangeKindIns:
		cell.Ins = &mark
	case cellChangeKindDel:
		cell.Del = &mark
	default:
		prev := docx.CellProps{}
		if span.BeforeShading != "" {
			if hex := normalizeShadingHex(span.BeforeShading); hex != "" {
				if rgba, ok := hexToRGBA(hex); ok {
					prev.Shading = docx.Shading{Fill: rgba, HasFill: true}
				}
			}
		}
		if span.BeforeBorders != nil {
			prev.Borders = borderAttrToBoxBorders(span.BeforeBorders)
		}
		cell.Props.TcPrChange = &docx.CellPropsChange{Mark: mark, Previous: prev}
	}
}
