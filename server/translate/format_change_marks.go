package translate

import (
	"github.com/nathanstitt/doctaculous/pkg/docx"
)

// formatChangeSpan tracks one PM suggestedFormatChange mark instance through
// the builder so the customXml part records the (w:id -> suggestionId) mapping,
// and so the run's RunProps.RPrChange can be built from the before-state marks.
type formatChangeSpan struct {
	// DocxRevisionID is the w:id written into <w:rPrChange>; the customXml
	// mapping is keyed by it.
	DocxRevisionID int
	SuggestionID   string
	AuthorID       string
	// Ts is the unix-ms timestamp from the PM mark attrs; ISO-8601 for w:date.
	Ts int64
	// BeforeMarks / AfterMarks are the SerializedMarks payloads the client
	// recorded: the run's mark set before the change (BeforeMarks, written into
	// the nested rPr inside w:rPrChange) and the proposed set (AfterMarks — the
	// outer rPr already reflects them since the run carries the AFTER marks).
	BeforeMarks []serializedMark
	AfterMarks  []serializedMark
}

// serializedMark is the Go-side view of the TS SerializedMarks payload
// (see webview-editor/source/suggestions/suggestion-types.ts). Encoded as
// JSON-from-TS, so attrs is a free-form map.
type serializedMark struct {
	Type  string         `json:"type"`
	Attrs map[string]any `json:"attrs,omitempty"`
}

// queueFormatChangeMarks emits one formatChangeSpan per suggestedFormatChange
// mark, stamping a fresh DocxRevisionID and accumulating spans for later
// customXml serialization. Non-format-change marks are ignored.
func (b *builder) queueFormatChangeMarks(marks []PMMark) []formatChangeSpan {
	if len(marks) == 0 {
		return nil
	}
	var spans []formatChangeSpan
	for _, m := range marks {
		if m.Type != MarkTypeSuggestedFormatChange {
			continue
		}
		suggestionID, _ := m.Attrs["suggestionId"].(string)
		authorID, _ := m.Attrs["authorId"].(string)
		ts := unixMsFromAny(m.Attrs["ts"])
		b.formatChangeSeq++
		span := formatChangeSpan{
			DocxRevisionID: b.formatChangeSeq,
			SuggestionID:   suggestionID,
			AuthorID:       authorID,
			Ts:             ts,
			BeforeMarks:    serializedMarksFromAttr(m.Attrs["before"]),
			AfterMarks:     serializedMarksFromAttr(m.Attrs["after"]),
		}
		b.formatChangeSpans = append(b.formatChangeSpans, span)
		spans = append(spans, span)
	}
	return spans
}

// unixMsFromAny coerces the ts attr to int64. PMMark.Attrs comes in via
// json.Unmarshal so a numeric value lands as float64; int / int64 tolerated.
func unixMsFromAny(v any) int64 {
	switch n := v.(type) {
	case float64:
		return int64(n)
	case int:
		return int64(n)
	case int64:
		return n
	}
	return 0
}

// serializedMarksFromAttr converts a `before` / `after` attribute value (from
// JSON as []any of map[string]any) into a flat []serializedMark slice.
func serializedMarksFromAttr(v any) []serializedMark {
	arr, ok := v.([]any)
	if !ok || len(arr) == 0 {
		return nil
	}
	out := make([]serializedMark, 0, len(arr))
	for _, item := range arr {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		t, _ := m["type"].(string)
		if t == "" {
			continue
		}
		entry := serializedMark{Type: t}
		if attrs, ok := m["attrs"].(map[string]any); ok && len(attrs) > 0 {
			entry.Attrs = attrs
		}
		out = append(out, entry)
	}
	return out
}

// serializedMarksToRunProps builds the before-state docx.RunProps that sits
// inside <w:rPrChange> from a SerializedMarks slice. Covers the same mark
// surface as marksToRunProps: bold/italic/underline/strike, code (VerbatimChar
// style), and textStyle color/fontFamily/fontSize/backgroundColor. Unknown mark
// types are dropped (an empty before-state is a valid "no formatting before").
func serializedMarksToRunProps(marks []serializedMark) docx.RunProps {
	var p docx.RunProps
	for _, m := range marks {
		switch m.Type {
		case MarkTypeCode:
			p.StyleID = "VerbatimChar"
		case MarkTypeBold:
			p.Bold, p.HasBold = true, true
		case MarkTypeItalic:
			p.Italic, p.HasItalic = true, true
		case MarkTypeUnderline:
			p.Underline, p.HasUnderline = true, true
		case MarkTypeStrike:
			p.Strike, p.HasStrike = true, true
		}
	}
	for _, m := range marks {
		if m.Type != MarkTypeTextStyle {
			continue
		}
		if f, ok := m.Attrs["fontFamily"].(string); ok && f != "" {
			p.Family = f
		}
		if c, ok := m.Attrs["color"].(string); ok && c != "" {
			if rgba, ok := hexToRGBA(c); ok {
				p.Color, p.HasColor = rgba, true
			}
		}
		if px, ok := fontSizePxFromAttrs(m.Attrs); ok && px > 0 {
			if hp := PxToHalfPoints(px); hp > 0 {
				p.SizeHalfPts, p.HasSize = hp, true
			}
		}
		if bg, ok := m.Attrs["backgroundColor"].(string); ok && bg != "" {
			if hex, ok := normalizeColorToHex(bg); ok {
				if rgba, ok := hexToRGBA(hex); ok {
					p.Shd = docx.Shading{Fill: rgba, HasFill: true}
				}
			}
		}
	}
	return p
}
