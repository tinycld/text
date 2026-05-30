package translate

import (
	"strconv"
	"strings"
)

// formatChangeSpan tracks one PM suggestedFormatChange mark instance
// through the emitter so the post-process pass can splice a
// <w:rPrChange> wrapper into the run's <w:rPr>. Mirrors suggestionSpan
// in shape — one entry per (run, mark) pair the emitter encounters.
// Layered format-change marks on the same range (Case 2c) produce
// multiple entries; the rewriter is idempotent so nested cases compose
// cleanly even though only one <w:rPrChange> can sit inside any single
// <w:rPr>.
type formatChangeSpan struct {
	// DocxRevisionID is the w:id we'll write into <w:rPrChange>. Same
	// shape as suggestionSpan's DocxRevisionID — docx requires the
	// attribute be an unsigned integer and the customXml mapping is
	// keyed by it.
	DocxRevisionID int
	SuggestionID   string
	AuthorID       string
	// Ts is the unix-ms timestamp from the PM mark attrs; converted to
	// ISO-8601 for the w:date attribute on emit.
	Ts int64
	// BeforeMarks / AfterMarks are the SerializedMarks payloads the
	// client recorded with the proposal: the run's mark set immediately
	// before the change (BeforeMarks, written into the nested <w:rPr>
	// inside <w:rPrChange>) and the proposed mark set (AfterMarks, used
	// only as a sanity reference — the outer <w:rPr> WordZero produced
	// already reflects them since the run carries the AFTER marks at
	// emit time).
	BeforeMarks []serializedMark
	AfterMarks  []serializedMark
	// Marker is the single placeholder text token planted as a bare run
	// immediately AFTER the real text run. The post-process pass uses
	// the marker to locate the preceding run (the one carrying the
	// AFTER marks) and inject <w:rPrChange> into its <w:rPr>. Unlike
	// suggestionSpan / commentSpan which plant matched open/close
	// markers around their content, formatChangeSpan only needs a
	// single anchor — the rPrChange wrapper is a single XML splice into
	// the run's existing <w:rPr>, not a wrapper spanning multiple runs.
	Marker string
}

// serializedMark is the Go-side view of the TS SerializedMarks payload
// (see webview-editor/source/suggestions/suggestion-types.ts).
// Encoded as JSON-from-TS, so attrs is a free-form map. Local to the
// translator package since callers cross the json.RawMessage boundary
// when assembling marks from PMMark.Attrs.
type serializedMark struct {
	Type  string         `json:"type"`
	Attrs map[string]any `json:"attrs,omitempty"`
}

// formatChangeOpenToken formats a unique marker text the rewriter
// recognises in document.xml. Numbered by em.formatChangeSpanSeq so each
// (run, mark) pair gets its own anchor — same pattern as
// codeOpenToken / bgColorOpenToken.
func formatChangeOpenToken(n int) string {
	return "{{__pmrpr:" + strconv.Itoa(n) + ":anchor}}"
}

// queueFormatChangeMarks walks the given marks slice and emits one
// formatChangeSpan per suggestedFormatChange mark. Non-format-change
// marks are ignored. The emitter stamps a fresh DocxRevisionID per span
// and accumulates spans across the whole document walk.
//
// Returns the spans that should drive marker-token emission in the
// caller; the spans are also retained on the emitter (em.formatChangeSpans)
// for later serialization in postProcessRichXML / writeSuggestionsCustomXML.
func (em *emitter) queueFormatChangeMarks(marks []PMMark) []formatChangeSpan {
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
		em.formatChangeSpanSeq++
		span := formatChangeSpan{
			DocxRevisionID: em.formatChangeSpanSeq,
			SuggestionID:   suggestionID,
			AuthorID:       authorID,
			Ts:             ts,
			BeforeMarks:    serializedMarksFromAttr(m.Attrs["before"]),
			AfterMarks:     serializedMarksFromAttr(m.Attrs["after"]),
			Marker:         formatChangeOpenToken(em.formatChangeSpanSeq),
		}
		em.formatChangeSpans = append(em.formatChangeSpans, span)
		spans = append(spans, span)
	}
	return spans
}

// unixMsFromAny coerces the ts attr to int64. PMMark.Attrs comes in via
// json.Unmarshal so a numeric value lands as float64; integer-typed
// callers (test fixtures) may pass int / int64 directly.
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

// serializedMarksFromAttr converts a `before` / `after` attribute value
// (which arrived from JSON as []any of map[string]any entries) into a
// flat []serializedMark slice the rewriter can iterate. Nil / wrong-
// shape input returns nil so the rewriter degrades gracefully (an
// empty BEFORE rPr is still valid XML; Word reads it as "no proposed
// changes" and the docx still opens).
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

// serializedMarksToRPrChildren formats a SerializedMarks slice into the
// XML child elements that sit inside a docx <w:rPr>. Covers the same
// mark surface area as marksToTextFormat / patchLastRunFontSize plus
// the highlight / link cases — anything we can represent on a run we
// can also represent in the BEFORE-state nested <w:rPr> so accept /
// reject can rebuild the original run exactly.
//
// Unknown / unsupported mark types are silently dropped (a BEFORE rPr
// with no recognized marks degrades to an empty <w:rPr> which Word
// reads as "no formatting before" — accept gives the AFTER state and
// reject strips all run-level formatting, matching the proposal's
// natural intent).
func serializedMarksToRPrChildren(marks []serializedMark) string {
	if len(marks) == 0 {
		return ""
	}
	var sb strings.Builder
	// rStyle goes first so character-style references appear in the
	// "natural" docx ordering Word emits (style → toggles → font/size →
	// color/highlight). Important: the rPr inside w:rPrChange should
	// look like a normal authoring-order rPr; some readers are strict.
	for _, m := range marks {
		if m.Type == MarkTypeCode {
			sb.WriteString(`<w:rStyle w:val="VerbatimChar"/>`)
		}
	}
	for _, m := range marks {
		switch m.Type {
		case MarkTypeBold:
			sb.WriteString(`<w:b/>`)
		case MarkTypeItalic:
			sb.WriteString(`<w:i/>`)
		case MarkTypeUnderline:
			sb.WriteString(`<w:u w:val="single"/>`)
		case MarkTypeStrike:
			sb.WriteString(`<w:strike/>`)
		}
	}
	// Font family (rFonts) before color/size, matching the order
	// marksToTextFormat + patchLastRunFontSize produce on emit.
	for _, m := range marks {
		if m.Type != MarkTypeTextStyle {
			continue
		}
		if fontFamily, ok := m.Attrs["fontFamily"].(string); ok && fontFamily != "" {
			esc := xmlEscape(fontFamily)
			sb.WriteString(`<w:rFonts w:ascii="`)
			sb.WriteString(esc)
			sb.WriteString(`" w:hAnsi="`)
			sb.WriteString(esc)
			sb.WriteString(`"/>`)
		}
	}
	for _, m := range marks {
		if m.Type != MarkTypeTextStyle {
			continue
		}
		if c, ok := m.Attrs["color"].(string); ok && c != "" {
			sb.WriteString(`<w:color w:val="`)
			sb.WriteString(stripHashUpper(c))
			sb.WriteString(`"/>`)
		}
		if sz, ok := fontSizePxFromAttrs(m.Attrs); ok && sz > 0 {
			halfPoints := PxToHalfPoints(sz)
			sb.WriteString(`<w:sz w:val="`)
			sb.WriteString(strconv.Itoa(halfPoints))
			sb.WriteString(`"/>`)
		}
		if bg, ok := m.Attrs["backgroundColor"].(string); ok && bg != "" {
			// Emit as <w:shd> (precise hex form). The importer accepts
			// both shd and highlight; round-trip through shd preserves
			// non-palette colors that highlight would have to coerce.
			hex := stripHashUpper(bg)
			if len(hex) == 6 {
				sb.WriteString(`<w:shd w:val="clear" w:color="auto" w:fill="`)
				sb.WriteString(hex)
				sb.WriteString(`"/>`)
			}
		}
	}
	return sb.String()
}

// stripHashUpper returns the input with any leading "#" removed and the
// hex uppercased — the form OOXML expects for <w:color> / <w:shd>.
// Non-hex input passes through unchanged; the consumer treats it as a
// soft drop (Word ignores values it can't parse).
func stripHashUpper(s string) string {
	return strings.ToUpper(strings.TrimPrefix(s, "#"))
}
