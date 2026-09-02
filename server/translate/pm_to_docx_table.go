package translate

// Table emission: a PM table becomes a docx.Table with a fixed column grid,
// per-cell GridSpan (colspan), and synthesized vMerge restart/continue chains
// (rowspan). PM omits the covered cells under a rowspan, so we materialize the
// vMergeContinue placeholder cells the importer's consolidateVMerges expects.

import (
	"fmt"

	"github.com/nathanstitt/omnidoc/pkg/docx"
)

// emitTable builds a docx.Table sized to the PM rows/cols. Each physical grid
// slot gets a cell: a real cell at its origin, or a synthesized vMergeContinue
// cell for rows a rowspan covers.
func (b *builder) emitTable(out *[]docx.Block, node PMNode) error {
	rows := len(node.Content)
	if rows == 0 {
		return nil
	}
	cols, colDxa := tableGeometry(node)
	if cols == 0 {
		return nil
	}

	tbl := &docx.Table{Props: docx.TableProps{LayoutFixed: true}}
	if len(colDxa) == cols {
		for _, dxa := range colDxa {
			tbl.Grid = append(tbl.Grid, docx.Twips(dxa))
		}
	}

	// Build a physical grid so vMerge continue cells land in the right column.
	// pending[c] > 0 means column c is still covered by an active rowspan.
	pending := make([]int, cols)
	physRows := make([][]docx.TableCell, rows)

	// fillCovered emits vMergeContinue cells for every currently-covered column
	// starting at *col, stopping at the first uncovered column (or cols).
	fillCovered := func(r int, col *int) {
		for *col < cols && pending[*col] > 0 {
			physRows[r] = append(physRows[r], docx.TableCell{GridSpan: 1, VMerge: docx.VMergeContinue})
			pending[*col]--
			*col++
		}
	}

	for r, row := range node.Content {
		if row.Type != NodeTypeTableRow {
			continue
		}
		physRows[r] = make([]docx.TableCell, 0, cols)
		col := 0
		for _, cell := range row.Content {
			if cell.Type != NodeTypeTableCell {
				continue
			}
			fillCovered(r, &col)
			if col >= cols {
				break
			}
			span := cellColspan(cell)
			if col+span > cols {
				span = cols - col
			}
			rspan := cellRowspan(cell)

			tc, err := b.emitTableCell(cell, span, rspan > 1)
			if err != nil {
				return err
			}
			physRows[r] = append(physRows[r], tc)

			if rspan > 1 {
				endRow := r + rspan - 1
				if endRow >= rows {
					endRow = rows - 1
				}
				coverRows := endRow - r
				for c := col; c < col+span && c < cols; c++ {
					pending[c] = coverRows
				}
			}
			col += span
		}
		// Trailing covered columns after the last real cell in this row.
		fillCovered(r, &col)
	}

	for r := range physRows {
		tbl.Rows = append(tbl.Rows, docx.TableRow{Cells: physRows[r]})
	}
	*out = append(*out, docx.Block{Table: tbl})
	return nil
}

// emitTableCell builds one docx.TableCell: content (recursing block children),
// grid span, vMerge restart (for rowspan origins), width, borders, shading, and
// any cell-change. rowspanOrigin marks a cell that spans rows.
func (b *builder) emitTableCell(cell PMNode, span int, rowspanOrigin bool) (docx.TableCell, error) {
	tc := docx.TableCell{GridSpan: span}
	if rowspanOrigin {
		tc.VMerge = docx.VMergeRestart
	}

	// Cell width: sum the per-column dxa across the span (best-effort — the
	// importer prefers the grid, so this is a hint).
	if cw, ok := cellColwidthPx(cell); ok && len(cw) > 0 {
		total := 0
		for i := 0; i < span; i++ {
			if i < len(cw) {
				total += pxToDxa(cw[i])
			} else {
				total += pxToDxa(cw[len(cw)-1])
			}
		}
		if total > 0 {
			tc.Props.WidthDxa = docx.Twips(total)
		}
	}

	if borders, ok := tcBordersFromAttr(cell.Attrs); ok {
		tc.Props.Borders = borders
	}
	if shading, ok := tcShadingFromAttr(cell.Attrs); ok {
		tc.Props.Shading = shading
	}
	if span := b.queueCellChangeAttrs(cell.Attrs); span != nil {
		span.applyCellChange(&tc)
	}

	for _, child := range cell.Content {
		switch child.Type {
		case NodeTypeParagraph, NodeTypeTable:
			if err := b.emitBlock(&tc.Blocks, child, 0, ""); err != nil {
				return tc, err
			}
		default:
			// Unrepresentable cell content: salvage its text into a plain
			// paragraph so the visible content survives, and warn.
			text := collectNodeText(child)
			if text != "" {
				tc.Blocks = append(tc.Blocks, docx.Block{Paragraph: &docx.Paragraph{
					Content: []docx.ParaChild{{Run: &docx.Run{Text: text}}}}})
			}
			b.addWarning(WarningCellContentFlattened,
				fmt.Sprintf("table cell %q content flattened to plain text", child.Type))
		}
	}
	return tc, nil
}

// tableGeometry counts physical columns and computes a per-column dxa width
// array, derived from the first row that carries colwidth on every cell. Falls
// back to (max cell count across rows, no widths) when no row carries widths.
func tableGeometry(table PMNode) (int, []int) {
	maxCells := 0
	for _, row := range table.Content {
		if row.Type == NodeTypeTableRow {
			if c := len(row.Content); c > maxCells {
				maxCells = c
			}
		}
	}
	for _, row := range table.Content {
		if row.Type != NodeTypeTableRow {
			continue
		}
		widths := []int{}
		ok := true
		totalCols := 0
		for _, cell := range row.Content {
			if cell.Type != NodeTypeTableCell {
				continue
			}
			span := cellColspan(cell)
			cw, hasCW := cellColwidthPx(cell)
			if !hasCW || len(cw) == 0 {
				ok = false
				break
			}
			for i := 0; i < span; i++ {
				if i < len(cw) {
					widths = append(widths, pxToDxa(cw[i]))
				} else {
					widths = append(widths, pxToDxa(cw[len(cw)-1]))
				}
			}
			totalCols += span
		}
		if ok && totalCols > 0 {
			if totalCols > maxCells {
				maxCells = totalCols
			}
			return totalCols, widths
		}
	}
	return maxCells, nil
}

// cellColspan reads colspan off a tableCell, defaulting to 1.
func cellColspan(cell PMNode) int {
	if cell.Attrs == nil {
		return 1
	}
	if v, ok := cell.Attrs["colspan"]; ok {
		if n := asInt(v); n > 0 {
			return n
		}
	}
	return 1
}

// cellRowspan reads rowspan off a tableCell, defaulting to 1.
func cellRowspan(cell PMNode) int {
	if cell.Attrs == nil {
		return 1
	}
	if v, ok := cell.Attrs["rowspan"]; ok {
		if n := asInt(v); n > 0 {
			return n
		}
	}
	return 1
}

// cellColwidthPx reads colwidth off a tableCell as an int slice (px).
func cellColwidthPx(cell PMNode) ([]int, bool) {
	if cell.Attrs == nil {
		return nil, false
	}
	raw, ok := cell.Attrs["colwidth"]
	if !ok {
		return nil, false
	}
	arr, ok := raw.([]any)
	if !ok {
		if a, ok2 := raw.([]int); ok2 {
			return a, true
		}
		return nil, false
	}
	out := make([]int, 0, len(arr))
	for _, v := range arr {
		out = append(out, asInt(v))
	}
	return out, true
}

// pxToDxa converts px to dxa/twips (1 dxa ≈ 1/15 px at 96 dpi), matching the
// importer's dxaToPx = dxa/15.
func pxToDxa(px int) int {
	if px <= 0 {
		return 0
	}
	return px * 15
}
