package translate

import (
	"strings"

	"github.com/nathanstitt/omnidoc/pkg/docx"
)

// normalizeShadingHex coerces whatever the .docx (or external caller) gave us
// into the canonical "#RRGGBB" uppercase form we store on the PM node. Returns
// empty string for anything that isn't six hex digits.
func normalizeShadingHex(raw string) string {
	value := raw
	if strings.HasPrefix(value, "#") {
		value = value[1:]
	}
	if len(value) != 6 {
		return ""
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		isHex := (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
		if !isHex {
			return ""
		}
	}
	return "#" + strings.ToUpper(value)
}

// tcShadingFromAttr builds a docx.Shading from the `shading` PM attr. Returns
// (shading, true) on a valid hex; (zero, false) when the attr is missing, the
// wrong shape, or not a valid hex.
func tcShadingFromAttr(attrs map[string]any) (docx.Shading, bool) {
	raw, ok := attrs["shading"].(string)
	if !ok || raw == "" {
		return docx.Shading{}, false
	}
	normalized := normalizeShadingHex(raw)
	if normalized == "" {
		return docx.Shading{}, false
	}
	rgba, ok := hexToRGBA(normalized)
	if !ok {
		return docx.Shading{}, false
	}
	return docx.Shading{Fill: rgba, HasFill: true}, true
}
