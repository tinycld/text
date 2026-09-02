package translate

import (
	"github.com/nathanstitt/omnidoc/pkg/docx"
)

// cellBorderAttr is the structured shape of the `borders` attribute we attach
// to tableCell / tableHeader PM nodes. Mirrors the TS-side CellBorders /
// CellBorder shape in @tinycld/text/lib/cell-borders.ts.
type cellBorderAttr struct {
	Top    *cellEdge `json:"top,omitempty"`
	Right  *cellEdge `json:"right,omitempty"`
	Bottom *cellEdge `json:"bottom,omitempty"`
	Left   *cellEdge `json:"left,omitempty"`
}

type cellEdge struct {
	Style   string `json:"style"`
	WidthPx int    `json:"widthPx"`
	Color   string `json:"color,omitempty"`
}

// mapBorderStyle maps OOXML's ST_Border enum to the much smaller CSS
// border-style subset we represent.
func mapBorderStyle(val string) string {
	switch val {
	case "none", "nil":
		return "none"
	case "dashed", "dashSmallGap", "dashDotStroked":
		return "dashed"
	case "dotted":
		return "dotted"
	case "double", "doubleWave":
		return "double"
	default:
		return "solid"
	}
}

// bordersToAttr returns the borders struct as a map[string]any tree — the
// shape PMNode.Attrs uses end-to-end.
func bordersToAttr(b *cellBorderAttr) map[string]any {
	out := map[string]any{}
	if b.Top != nil {
		out["top"] = edgeToMap(b.Top)
	} else {
		out["top"] = nil
	}
	if b.Right != nil {
		out["right"] = edgeToMap(b.Right)
	} else {
		out["right"] = nil
	}
	if b.Bottom != nil {
		out["bottom"] = edgeToMap(b.Bottom)
	} else {
		out["bottom"] = nil
	}
	if b.Left != nil {
		out["left"] = edgeToMap(b.Left)
	} else {
		out["left"] = nil
	}
	return out
}

func edgeToMap(e *cellEdge) map[string]any {
	out := map[string]any{
		"style":   e.Style,
		"widthPx": e.WidthPx,
	}
	if e.Color != "" {
		out["color"] = e.Color
	} else {
		out["color"] = nil
	}
	return out
}

// tcBordersFromAttr builds a docx.BoxBorders from the `borders` PM attr.
// Returns (borders, true) when at least one edge is set; (zero, false)
// otherwise (missing attr, wrong shape, or all edges nil).
func tcBordersFromAttr(attrs map[string]any) (docx.BoxBorders, bool) {
	raw, ok := attrs["borders"].(map[string]any)
	if !ok {
		return docx.BoxBorders{}, false
	}
	return boxBordersFromRaw(raw)
}

// borderAttrToBoxBorders converts a raw borders map into a docx.BoxBorders,
// returning the zero value when it carries no edges. Used by the cell-change
// before-state builder.
func borderAttrToBoxBorders(raw map[string]any) docx.BoxBorders {
	b, _ := boxBordersFromRaw(raw)
	return b
}

func boxBordersFromRaw(raw map[string]any) (docx.BoxBorders, bool) {
	var out docx.BoxBorders
	any := false
	if e, ok := edgeFromAttr(raw["top"]); ok {
		out.Top, any = e, true
	}
	if e, ok := edgeFromAttr(raw["right"]); ok {
		out.Right, any = e, true
	}
	if e, ok := edgeFromAttr(raw["bottom"]); ok {
		out.Bottom, any = e, true
	}
	if e, ok := edgeFromAttr(raw["left"]); ok {
		out.Left, any = e, true
	}
	return out, any
}

// edgeFromAttr builds one docx.Border from a raw edge map. Returns ok=false for
// a missing / styleless edge. Width conversion is px -> 1/8 point (px*6), the
// inverse of the importer's decode, clamped to >= 4 (~0.5pt).
func edgeFromAttr(raw any) (docx.Border, bool) {
	m, ok := raw.(map[string]any)
	if !ok || m == nil {
		return docx.Border{}, false
	}
	style, _ := m["style"].(string)
	if style == "" {
		return docx.Border{}, false
	}
	if style == "none" {
		return docx.Border{None: true}, true
	}

	width := 1
	if v, ok := m["widthPx"].(float64); ok {
		width = int(v)
	} else if v, ok := m["widthPx"].(int); ok {
		width = v
	}
	sz := width * 6
	if sz < 4 {
		sz = 4
	}
	edge := docx.Border{Style: cssStyleToBorderVal(style), SizeEighthPt: sz}
	if colorStr, _ := m["color"].(string); colorStr != "" {
		if rgba, ok := hexToRGBA(colorStr); ok {
			edge.Color, edge.HasColor = rgba, true
		}
	}
	return edge, true
}

// cssStyleToBorderVal maps our CSS border-style subset to the OOXML ST_Border
// value the writer emits.
func cssStyleToBorderVal(style string) string {
	switch style {
	case "dashed":
		return "dashed"
	case "dotted":
		return "dotted"
	case "double":
		return "double"
	default:
		return "single"
	}
}
