package translate

import (
	"strconv"

	"github.com/ZeroHawkeye/wordZero/pkg/document"
)

// cellBorderAttr is the structured shape of the `borders` attribute we
// attach to tableCell / tableHeader PM nodes. Mirrors the TS-side
// CellBorders / CellBorder shape in @tinycld/text/lib/cell-borders.ts.
//
// JSON tag names match the camelCase used in the editor JSON; both the
// importer (we emit this struct, JSON encodes it via map[string]any
// round-trip below) and the emitter (we read it back from those maps)
// agree on the shape.
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
// border-style subset we represent. Word has dozens of decorative
// variants (threeDEmboss, wave, dashSmallGap, …); we collapse them all
// to 'solid' since CSS has no equivalent and we'd otherwise drop the
// border entirely. The four CSS-native styles round-trip cleanly.
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

// bordersToAttr returns the borders struct as a map[string]any tree —
// the shape PMNode.Attrs uses end-to-end. Encoding as a map (rather
// than the typed struct) keeps it symmetric with how every other PM
// attr is shaped, and lets the yjs bridge JSON-marshal it without
// special cases.
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

// tcBordersFromAttr builds a WordZero TableCellBorders from the
// `borders` PM attr. Returns nil when the attr is missing, the wrong
// shape, or all four edges are nil (no border data). The emitter
// attaches the result to TableCellProperties.TcBorders if non-nil.
//
// Width conversion is the inverse of decodeBorderEdge: px → 1/8 point.
// w:sz="8" = 1pt = "thin" Word border, which is also the common
// default. We clamp to >= 4 (≈ 0.5pt) so editors that emit a 0px
// border (effectively "hairline") still produce a visible Word line.
func tcBordersFromAttr(attrs map[string]any) *document.TableCellBorders {
	raw, ok := attrs["borders"].(map[string]any)
	if !ok {
		return nil
	}
	out := &document.TableCellBorders{}
	if e := edgeFromAttr(raw["top"]); e != nil {
		out.Top = e
	}
	if e := edgeFromAttr(raw["right"]); e != nil {
		out.Right = e
	}
	if e := edgeFromAttr(raw["bottom"]); e != nil {
		out.Bottom = e
	}
	if e := edgeFromAttr(raw["left"]); e != nil {
		out.Left = e
	}
	if out.Top == nil && out.Right == nil && out.Bottom == nil && out.Left == nil {
		return nil
	}
	return out
}

func edgeFromAttr(raw any) *document.TableCellBorder {
	m, ok := raw.(map[string]any)
	if !ok || m == nil {
		return nil
	}
	style, _ := m["style"].(string)
	if style == "" {
		return nil
	}
	width := 1
	if v, ok := m["widthPx"].(float64); ok {
		width = int(v)
	} else if v, ok := m["widthPx"].(int); ok {
		width = v
	}
	color, _ := m["color"].(string)

	if style == "none" {
		return &document.TableCellBorder{Val: "nil"}
	}

	// px → 1/8 point: px * 72 / 96 * 8 = px * 6
	sz := width * 6
	if sz < 4 {
		sz = 4
	}
	out := &document.TableCellBorder{
		Val: cssStyleToBorderVal(style),
		Sz:  strconv.Itoa(sz),
	}
	if color != "" {
		// Strip leading '#' if present; Word stores colors as raw RRGGBB.
		if len(color) > 0 && color[0] == '#' {
			color = color[1:]
		}
		out.Color = color
	} else {
		out.Color = "auto"
	}
	return out
}

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
