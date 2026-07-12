package translate

// Pure value helpers shared by the emitter: color normalization and font-size
// parsing. These are output-type-agnostic (they produce hex strings / ints);
// the caller converts to the docx model.

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// bgColorHexFromMarks extracts the textStyle mark's backgroundColor attr and
// normalizes it to a 6-digit RRGGBB hex string (no leading '#'). Returns:
//
//   - (hex, "", true)    — a hex value (literal or normalized from rgb()/rgba())
//   - ("",  raw, false)  — a backgroundColor was set but could not be normalized
//   - ("",  "",  false)  — no backgroundColor on any textStyle mark
func bgColorHexFromMarks(marks []PMMark) (hex, raw string, ok bool) {
	for _, m := range marks {
		if m.Type != MarkTypeTextStyle {
			continue
		}
		c, isString := m.Attrs["backgroundColor"].(string)
		if !isString || c == "" {
			continue
		}
		if normalized, ok := normalizeColorToHex(c); ok {
			return normalized, "", true
		}
		return "", c, false
	}
	return "", "", false
}

// normalizeColorToHex converts a CSS color string to a 6-digit uppercase
// RRGGBB hex. Accepts "#RRGGBB"/"RRGGBB", "rgb(r,g,b)", and "rgba(r,g,b,a)"
// (alpha dropped). All other forms (named colors, hsl(), …) return ok=false.
func normalizeColorToHex(value string) (string, bool) {
	v := strings.TrimSpace(value)
	if v == "" {
		return "", false
	}
	if strings.HasPrefix(v, "#") || isPlainHex(v) {
		hex := strings.TrimPrefix(v, "#")
		if len(hex) != 6 || !isPlainHex(hex) {
			return "", false
		}
		return strings.ToUpper(hex), true
	}
	lower := strings.ToLower(v)
	if strings.HasPrefix(lower, "rgb(") || strings.HasPrefix(lower, "rgba(") {
		open := strings.IndexByte(v, '(')
		closeIdx := strings.LastIndexByte(v, ')')
		if open < 0 || closeIdx <= open {
			return "", false
		}
		parts := strings.Split(v[open+1:closeIdx], ",")
		if len(parts) < 3 {
			return "", false
		}
		r, rOK := parseColorByte(parts[0])
		g, gOK := parseColorByte(parts[1])
		b, bOK := parseColorByte(parts[2])
		if !rOK || !gOK || !bOK {
			return "", false
		}
		return fmt.Sprintf("%02X%02X%02X", r, g, b), true
	}
	return "", false
}

// isPlainHex reports whether s consists entirely of 0-9 / a-f / A-F.
func isPlainHex(s string) bool {
	for _, ch := range s {
		isHex := (ch >= '0' && ch <= '9') ||
			(ch >= 'a' && ch <= 'f') ||
			(ch >= 'A' && ch <= 'F')
		if !isHex {
			return false
		}
	}
	return s != ""
}

// parseColorByte parses one CSS rgb()/rgba() component (integer 0-255, or a
// trailing-'%' 0-100 form). Returns ok=false on parse error / out of range.
func parseColorByte(s string) (uint8, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	if strings.HasSuffix(s, "%") {
		raw := strings.TrimSuffix(s, "%")
		f, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
		if err != nil || f < 0 || f > 100 {
			return 0, false
		}
		return uint8((f / 100.0) * 255.0), true
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < 0 || n > 255 {
		return 0, false
	}
	return uint8(n), true
}

// hasCodeMark reports whether the given marks carry an inline `code` mark.
func hasCodeMark(marks []PMMark) bool {
	for _, m := range marks {
		if m.Type == MarkTypeCode {
			return true
		}
	}
	return false
}

// fontSizePxFromAttrs reads the textStyle mark's fontSize attr, stored by the
// editor as a CSS pixel string ("16px"). Numeric forms (float64 / int) are also
// accepted for fixtures. Returns 0 for missing / zero / unparseable.
func fontSizePxFromAttrs(attrs map[string]any) (int, bool) {
	v, ok := attrs["fontSize"]
	if !ok {
		return 0, false
	}
	switch n := v.(type) {
	case float64:
		if n <= 0 {
			return 0, false
		}
		return int(n), true
	case int:
		if n <= 0 {
			return 0, false
		}
		return n, true
	case string:
		px, ok := parsePxString(n)
		if !ok || px <= 0 {
			return 0, false
		}
		return px, true
	}
	return 0, false
}

// parsePxString reads a CSS px length like "16px" / "16.5px" (bare numbers are
// treated as px), returning the rounded integer pixel value.
func parsePxString(raw string) (int, bool) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return 0, false
	}
	suffix := "px"
	lower := strings.ToLower(s)
	if !strings.HasSuffix(lower, suffix) {
		f, err := strconv.ParseFloat(s, 64)
		if err != nil || f <= 0 {
			return 0, false
		}
		return int(math.Round(f)), true
	}
	numPart := strings.TrimSpace(s[:len(s)-len(suffix)])
	f, err := strconv.ParseFloat(numPart, 64)
	if err != nil || f <= 0 {
		return 0, false
	}
	return int(math.Round(f)), true
}

// fontSizePxFromMarks scans for the textStyle mark's fontSize attr, in px.
func fontSizePxFromMarks(marks []PMMark) int {
	for _, m := range marks {
		if m.Type != MarkTypeTextStyle {
			continue
		}
		if px, ok := fontSizePxFromAttrs(m.Attrs); ok {
			return px
		}
	}
	return 0
}

// linkHref returns the first link mark's href, if any.
func linkHref(marks []PMMark) (string, bool) {
	for _, m := range marks {
		if m.Type == MarkTypeLink {
			if href, ok := m.Attrs["href"].(string); ok && href != "" {
				return href, true
			}
		}
	}
	return "", false
}
