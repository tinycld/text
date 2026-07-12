package translate

import (
	"fmt"
	"math"
	"strings"

	"github.com/nathanstitt/doctaculous/pkg/docx"
)

// walkTable is the model-walk equivalent of parseTable: it walks a parsed table
// into the flat PM table (one cell per w:tc, vMerge sentinels carried) and runs
// the preserved consolidateVMerges + padTableRowsToMaxWidth post-passes.
func (p *docxParser) walkTable(tb *docx.Table) *PMNode {
	tbl := &PMNode{Type: NodeTypeTable}
	gridCols := make([]int, len(tb.Grid))
	for i, g := range tb.Grid {
		gridCols[i] = int(g)
	}
	for ri := range tb.Rows {
		col := 0
		row := &PMNode{Type: NodeTypeTableRow}
		for ci := range tb.Rows[ri].Cells {
			cell := p.walkTableCell(tb.Rows[ri].Cells[ci], gridCols, col)
			row.Content = append(row.Content, *cell)
			col += cellColspanForPad(*cell)
		}
		tbl.Content = append(tbl.Content, *row)
	}
	consolidateVMerges(tbl)
	padTableRowsToMaxWidth(tbl)
	return tbl
}

// walkTableCell converts a parsed cell into a PM tableCell: borders/shading/
// vMerge/cell-change attrs, colwidth/colspan, list-attr stripping on cell
// paragraphs, and leading-empty-paragraph collapse — matching parseTableCell.
func (p *docxParser) walkTableCell(tc docx.TableCell, gridCols []int, colIdx int) *PMNode {
	cell := &PMNode{Type: NodeTypeTableCell}

	gridSpan := tc.GridSpan
	if gridSpan < 1 {
		gridSpan = 1
	}
	borders := boxBordersToAttr(tc.Props.Borders)
	shading := shadingToAttr(tc.Props.Shading)
	vMerge := vMergeToString(tc.VMerge)
	cellChange := p.cellChangeFromModel(tc)

	if borders != nil {
		ensureAttrs(cell)["borders"] = borders
	}
	if shading != "" {
		ensureAttrs(cell)["shading"] = shading
	}
	if vMerge != "" {
		ensureAttrs(cell)["_vmerge"] = vMerge
	}
	if cellChange != nil {
		attachCellChangeAttr(ensureAttrs(cell), cellChange, shading, borders)
	}

	for bi := range tc.Blocks {
		node := p.walkBlock(tc.Blocks[bi])
		if node == nil {
			continue
		}
		if node.Type == NodeTypeParagraph {
			// Cell paragraphs never participate in list grouping.
			if node.Attrs != nil {
				delete(node.Attrs, "_listNumId")
				delete(node.Attrs, "_listLevel")
				delete(node.Attrs, "_listFmt")
				if len(node.Attrs) == 0 {
					node.Attrs = nil
				}
			}
			cell.Content = append(cell.Content, liftInlineImages(*node)...)
		} else {
			cell.Content = append(cell.Content, *node)
		}
	}

	cell.Content = collapseLeadingEmptyParagraphs(cell.Content)
	applyTableCellWidth(cell, int(tc.Props.WidthDxa), gridSpan, gridCols, colIdx)
	return cell
}

// ensureAttrs lazily initializes a node's Attrs map and returns it.
func ensureAttrs(n *PMNode) map[string]any {
	if n.Attrs == nil {
		n.Attrs = map[string]any{}
	}
	return n.Attrs
}

// vMergeToString maps the parsed VMergeKind onto the "_vmerge" sentinel string
// consolidateVMerges consumes ("restart"/"continue"; "" for unmerged).
func vMergeToString(k docx.VMergeKind) string {
	switch k {
	case docx.VMergeRestart:
		return "restart"
	case docx.VMergeContinue:
		return "continue"
	default:
		return ""
	}
}

// cellChangeFromModel builds the half-filled cell-change attr from a parsed
// cell's tracked-change marks: w:cellIns / w:cellDel take precedence (they carry
// the added/deleted flag), else w:tcPrChange (properties change). Returns nil
// when the cell carries no change. Mirrors parseTableCellProperties' dispatch.
func (p *docxParser) cellChangeFromModel(tc docx.TableCell) map[string]any {
	if tc.Ins != nil {
		return p.cellInsDelFromModel(tc.Ins, true)
	}
	if tc.Del != nil {
		return p.cellInsDelFromModel(tc.Del, false)
	}
	if tc.Props.TcPrChange != nil {
		return p.tcPrChangeFromModel(tc.Props.TcPrChange)
	}
	return nil
}

// cellInsDelFromModel is the model equivalent of parseCellInsDel.
func (p *docxParser) cellInsDelFromModel(mark *docx.RevisionMark, isInsert bool) map[string]any {
	suggestionID := p.suggestionMapping.CellChange[mark.ID]
	if suggestionID == "" {
		prefix := "tcdel"
		if isInsert {
			prefix = "tcins"
		}
		suggestionID = fmt.Sprintf("docx:%s:%d:%s", prefix, mark.ID, mark.Author)
	}
	before := map[string]any{"type": NodeTypeTableCell, "attrs": map[string]any{}}
	after := map[string]any{"type": NodeTypeTableCell, "attrs": map[string]any{}}
	if isInsert {
		before["added"] = true
	} else {
		after["deleted"] = true
	}
	return map[string]any{
		"suggestionId": suggestionID,
		"authorId":     mark.Author,
		"ts":           float64(parseISO8601ToUnixMs(mark.Date)),
		"before":       before,
		"after":        after,
	}
}

// tcPrChangeFromModel is the model equivalent of parseTcPrChange: it builds the
// before-state cell attrs (shading/borders) from the Previous CellProps.
func (p *docxParser) tcPrChangeFromModel(ch *docx.CellPropsChange) map[string]any {
	suggestionID := p.suggestionMapping.CellChange[ch.Mark.ID]
	if suggestionID == "" {
		suggestionID = fmt.Sprintf("docx:tcpr:%d:%s", ch.Mark.ID, ch.Mark.Author)
	}
	beforeAttrs := map[string]any{}
	if s := shadingToAttr(ch.Previous.Shading); s != "" {
		beforeAttrs["shading"] = s
	}
	if b := boxBordersToAttr(ch.Previous.Borders); b != nil {
		beforeAttrs["borders"] = b
	}
	return map[string]any{
		"suggestionId": suggestionID,
		"authorId":     ch.Mark.Author,
		"ts":           float64(parseISO8601ToUnixMs(ch.Mark.Date)),
		"before": map[string]any{
			"type":  NodeTypeTableCell,
			"attrs": beforeAttrs,
		},
	}
}

// shadingToAttr is the model equivalent of parseTcShading: a parsed cell Shading
// becomes the "#RRGGBB" fill string, or "" when unset/auto.
func shadingToAttr(sh docx.Shading) string {
	if !sh.HasFill {
		return ""
	}
	return normalizeShadingHex(rgbHex(sh.Fill))
}

// boxBordersToAttr is the model equivalent of parseTcBorders + bordersToAttr: it
// converts a parsed BoxBorders into the `borders` PM attr map, or nil when no
// edge carries a usable value.
func boxBordersToAttr(b docx.BoxBorders) map[string]any {
	top := borderEdge(b.Top)
	right := borderEdge(b.Right)
	bottom := borderEdge(b.Bottom)
	left := borderEdge(b.Left)
	if top == nil && right == nil && bottom == nil && left == nil {
		return nil
	}
	return map[string]any{
		"top":    edgeToMapOrNil(top),
		"right":  edgeToMapOrNil(right),
		"bottom": edgeToMapOrNil(bottom),
		"left":   edgeToMapOrNil(left),
	}
}

// borderEdge converts one parsed Border into a cellEdge, mirroring
// decodeBorderEdge. An unset edge (no style, not explicitly none) yields nil;
// an explicit none yields {Style:"none"}.
func borderEdge(bd docx.Border) *cellEdge {
	if bd.None {
		return &cellEdge{Style: "none"}
	}
	if bd.Style == "" {
		return nil
	}
	style := mapBorderStyle(bd.Style)
	widthPx := 1
	if bd.SizeEighthPt > 0 {
		widthPx = int(math.Ceil(float64(bd.SizeEighthPt) / 8.0 * 96.0 / 72.0))
		if widthPx < 1 {
			widthPx = 1
		}
	}
	colorOut := ""
	if bd.HasColor {
		colorOut = "#" + strings.ToUpper(rgbHex(bd.Color))
	}
	return &cellEdge{Style: style, WidthPx: widthPx, Color: colorOut}
}

// edgeToMapOrNil is edgeToMap but returns a nil interface for a nil edge (so the
// attr map carries an explicit null, matching bordersToAttr).
func edgeToMapOrNil(e *cellEdge) any {
	if e == nil {
		return nil
	}
	return edgeToMap(e)
}
