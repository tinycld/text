package translate

import (
	"fmt"
	"strings"
)

// rewriteCellChangeMarkers replaces every {{__pmtcpr:N:anchor}} marker
// run we planted in emitTableCell with two effects:
//
//  1. Inject a <w:tcPrChange> / <w:cellIns> / <w:cellDel> element into
//     the enclosing cell's <w:tcPr> (or inject a fresh tcPr if absent).
//     For cellChangeKindAttr the inserted element is <w:tcPrChange>
//     wrapping a nested <w:tcPr> with the BEFORE state. For
//     cellChangeKindIns / cellChangeKindDel the inserted element is the
//     bare marker <w:cellIns> / <w:cellDel> with no nested body — Word
//     reads those as "this cell was proposed for addition / removal,
//     respectively." Either way the cell content stays in the document
//     until the suggestion is resolved.
//  2. Strip the marker run itself — it served only as the anchor.
//
// Idempotent on the surface: a marker that's already been processed
// produces a no-op. The rewriter runs after rewriteBlockChangeMarkers
// for deterministic test output; the two passes target separate XML
// regions (paragraph <w:pPr> vs. cell <w:tcPr>) so ordering is not
// load-bearing for correctness.
func rewriteCellChangeMarkers(doc string, spans []cellChangeSpan) string {
	for _, span := range spans {
		markerRun, markerIdx := findMarkerRun(doc, span.Marker)
		if markerIdx < 0 {
			continue
		}
		// Locate the enclosing <w:tc ...> tag. We search backwards from
		// the marker for the last <w:tc that's not <w:tcPr> / <w:tcW>.
		tcOpenStart := findEnclosingTableCellStart(doc, markerIdx)
		if tcOpenStart < 0 {
			// No enclosing cell. Strip the marker and move on.
			doc = doc[:markerIdx] + doc[markerIdx+len(markerRun):]
			continue
		}
		tcOpenEnd := strings.Index(doc[tcOpenStart:], ">")
		if tcOpenEnd < 0 {
			doc = doc[:markerIdx] + doc[markerIdx+len(markerRun):]
			continue
		}
		tcOpenEnd += tcOpenStart + 1 // offset just past the <w:tc ...> open tag

		// Strip the marker run first; the cell open tag is at or before
		// tcOpenStart < markerIdx so removing the run doesn't move the
		// cell open offsets.
		doc = doc[:markerIdx] + doc[markerIdx+len(markerRun):]

		// Build the inserted element and splice into the cell's tcPr
		// (or create a fresh tcPr if absent).
		insertedElem := buildCellChangeElementXML(span)
		doc = injectIntoTcPr(doc, tcOpenStart, tcOpenEnd, insertedElem)
	}
	return doc
}

// findEnclosingTableCellStart returns the offset of the <w:tc tag that
// encloses the given offset, scanning backwards. Skips false-positive
// matches on <w:tcPr>, <w:tcW>, <w:tcBorders>, etc. by requiring the
// char after "<w:tc" to be '>' or whitespace.
func findEnclosingTableCellStart(doc string, at int) int {
	off := at
	for off > 0 {
		idx := strings.LastIndex(doc[:off], "<w:tc")
		if idx < 0 {
			return -1
		}
		after := idx + len("<w:tc")
		if after < len(doc) {
			c := doc[after]
			if c == '>' || c == ' ' || c == '\t' || c == '\n' || c == '\r' {
				return idx
			}
		}
		off = idx
	}
	return -1
}

// injectIntoTcPr splices an element (<w:tcPrChange>, <w:cellIns>, or
// <w:cellDel>) into the cell's <w:tcPr>. Three tcPr shapes, mirroring
// injectPPrChange:
//
//  1. Cell already has a fully-formed <w:tcPr>…</w:tcPr>. Append the
//     element at the end of the tcPr.
//  2. Self-closing <w:tcPr/>. Replace with <w:tcPr><elem/></w:tcPr>.
//  3. No <w:tcPr>. Insert <w:tcPr><elem/></w:tcPr> right after the
//     cell's opening tag.
//
// The search for the existing tcPr is scoped to the region between the
// cell open tag and the next </w:tc> closing.
func injectIntoTcPr(doc string, tcOpenStart, tcOpenEnd int, insertedElem string) string {
	tcCloseRel := strings.Index(doc[tcOpenEnd:], "</w:tc>")
	if tcCloseRel < 0 {
		return doc
	}
	tcClose := tcOpenEnd + tcCloseRel
	region := doc[tcOpenEnd:tcClose]

	if rel := strings.Index(region, "</w:tcPr>"); rel >= 0 {
		insertAt := tcOpenEnd + rel
		return doc[:insertAt] + insertedElem + doc[insertAt:]
	}
	if rel := strings.Index(region, "<w:tcPr/>"); rel >= 0 {
		insertAt := tcOpenEnd + rel
		return doc[:insertAt] + "<w:tcPr>" + insertedElem + "</w:tcPr>" +
			doc[insertAt+len("<w:tcPr/>"):]
	}
	// No tcPr — insert a fresh one right after the cell open tag.
	return doc[:tcOpenEnd] + "<w:tcPr>" + insertedElem + "</w:tcPr>" + doc[tcOpenEnd:]
}

// buildCellChangeElementXML formats one cell-change element complete
// with w:id, w:author, w:date attributes. The shape depends on the
// span's Kind:
//   - cellChangeKindAttr → <w:tcPrChange ...><w:tcPr>BEFORE</w:tcPr></w:tcPrChange>
//   - cellChangeKindIns  → <w:cellIns .../>
//   - cellChangeKindDel  → <w:cellDel .../>
//
// w:date is omitted when ts==0 (same convention as buildSuggestionOpenTag
// / buildRPrChangeXML / buildPPrChangeXML).
func buildCellChangeElementXML(span cellChangeSpan) string {
	date := unixMsToISO8601(span.Ts)
	switch span.Kind {
	case cellChangeKindIns:
		return formatCellMarkerXML("w:cellIns", span.DocxRevisionID, span.AuthorID, date)
	case cellChangeKindDel:
		return formatCellMarkerXML("w:cellDel", span.DocxRevisionID, span.AuthorID, date)
	default:
		body := cellChangeBeforeTcPrChildren(span.BeforeShading, span.BeforeBorders)
		if date == "" {
			return fmt.Sprintf(`<w:tcPrChange w:id="%d" w:author=%q><w:tcPr>%s</w:tcPr></w:tcPrChange>`,
				span.DocxRevisionID,
				span.AuthorID,
				body)
		}
		return fmt.Sprintf(`<w:tcPrChange w:id="%d" w:author=%q w:date=%q><w:tcPr>%s</w:tcPr></w:tcPrChange>`,
			span.DocxRevisionID,
			span.AuthorID,
			date,
			body)
	}
}

// formatCellMarkerXML formats a self-closing <w:cellIns/> or
// <w:cellDel/> element with the standard rev-attrs (id/author/date).
// date is omitted when empty (ts==0).
func formatCellMarkerXML(tag string, id int, author, date string) string {
	if date == "" {
		return fmt.Sprintf(`<%s w:id="%d" w:author=%q/>`, tag, id, author)
	}
	return fmt.Sprintf(`<%s w:id="%d" w:author=%q w:date=%q/>`, tag, id, author, date)
}

// cellChangeBeforeTcPrChildren formats the BEFORE cell-properties
// payload as the children of the nested <w:tcPr> inside <w:tcPrChange>.
// Covers shading (<w:shd>) and borders (<w:tcBorders>) — the two cell
// attrs the v1 PM cell node carries. Unknown / empty BEFORE state
// degrades to an empty <w:tcPr>, which Word reads as "default cell
// properties" — accept/reject still works because the AFTER state on
// the outer tcPr is the canonical render and only the BEFORE state is
// scoped to the change wrapper.
func cellChangeBeforeTcPrChildren(shading string, borders map[string]any) string {
	var sb strings.Builder
	if shading != "" {
		hex := normalizeShadingHex(shading)
		if hex != "" {
			sb.WriteString(`<w:shd w:val="clear" w:color="auto" w:fill="`)
			sb.WriteString(strings.TrimPrefix(hex, "#"))
			sb.WriteString(`"/>`)
		}
	}
	if borders != nil {
		if x := bordersAttrToTcBordersXML(borders); x != "" {
			sb.WriteString(x)
		}
	}
	return sb.String()
}

// bordersAttrToTcBordersXML renders the borders attr (map from
// `top`/`right`/`bottom`/`left` to edge maps) as a <w:tcBorders>
// element. Returns empty string when no edges are present.
func bordersAttrToTcBordersXML(borders map[string]any) string {
	type edgeSpec struct {
		tag  string
		attr string
	}
	edges := []edgeSpec{
		{"w:top", "top"},
		{"w:left", "left"},
		{"w:bottom", "bottom"},
		{"w:right", "right"},
	}
	var inner strings.Builder
	hasAny := false
	for _, e := range edges {
		raw, ok := borders[e.attr]
		if !ok || raw == nil {
			continue
		}
		em, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		style, _ := em["style"].(string)
		if style == "" {
			continue
		}
		width := 1
		switch v := em["widthPx"].(type) {
		case float64:
			width = int(v)
		case int:
			width = v
		}
		color, _ := em["color"].(string)
		hasAny = true
		if style == "none" {
			inner.WriteString(`<`)
			inner.WriteString(e.tag)
			inner.WriteString(` w:val="nil"/>`)
			continue
		}
		// px → 1/8 point: px * 72 / 96 * 8 = px * 6
		sz := width * 6
		if sz < 4 {
			sz = 4
		}
		inner.WriteString(`<`)
		inner.WriteString(e.tag)
		inner.WriteString(` w:val="`)
		inner.WriteString(cssStyleToBorderVal(style))
		inner.WriteString(`" w:sz="`)
		inner.WriteString(intToStr(sz))
		inner.WriteString(`" w:color="`)
		if color != "" {
			inner.WriteString(strings.TrimPrefix(color, "#"))
		} else {
			inner.WriteString("auto")
		}
		inner.WriteString(`"/>`)
	}
	if !hasAny {
		return ""
	}
	return `<w:tcBorders>` + inner.String() + `</w:tcBorders>`
}

// intToStr is a thin wrapper around strconv.Itoa for local use; allows
// keeping the conversion next to the XML builder.
func intToStr(n int) string {
	return fmt.Sprintf("%d", n)
}
