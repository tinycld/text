package translate

import (
	"fmt"
	"strings"
)

// rewriteBlockChangeMarkers replaces every {{__pmppr:N:anchor}} marker
// run we planted in emitParagraph / emitHeading with two effects:
//
//  1. Inject a <w:pPrChange> wrapper into the enclosing paragraph's
//     <w:pPr>, carrying the BEFORE-state pPr children inside a nested
//     <w:pPr>. The outer <w:pPr> stays as WordZero produced it (the
//     AFTER state Word actually renders), with one exception: when
//     IsDelete is set we leave the outer pPr untouched even if the
//     after-shape would have rewritten pStyle/jc/ind — the paragraph
//     is being deleted, not re-styled, so the surviving pPr keeps the
//     BEFORE state.
//  2. Strip the marker run itself — it served only as the anchor for
//     finding the paragraph to patch.
//
// Idempotent on the surface: a marker that's already been processed
// (e.g. because a later pass re-ran the rewriter) produces a no-op.
// The order rewriteFormatChangeMarkers → rewriteBlockChangeMarkers is
// chosen so block-change rewrites happen after format-change rewrites
// — both target separate elements in separate parts of the paragraph
// (rPr inside runs vs. pPr at the paragraph level), so the order is
// not load-bearing for correctness; we run block changes last for
// deterministic test output.
func rewriteBlockChangeMarkers(doc string, spans []blockChangeSpan) string {
	for _, span := range spans {
		markerRun, markerIdx := findMarkerRun(doc, span.Marker)
		if markerIdx < 0 {
			continue
		}
		// Locate the enclosing <w:p ...> tag. We search backwards from
		// the marker for the last <w:p that's not <w:pPr> / <w:pStyle>.
		pOpenStart := findEnclosingParagraphStart(doc, markerIdx)
		if pOpenStart < 0 {
			// No enclosing paragraph. Strip the marker and move on — the
			// rewrite degrades to "no pPrChange emitted for this span"
			// which is preferable to corrupting the document.
			doc = doc[:markerIdx] + doc[markerIdx+len(markerRun):]
			continue
		}
		pOpenEnd := strings.Index(doc[pOpenStart:], ">")
		if pOpenEnd < 0 {
			doc = doc[:markerIdx] + doc[markerIdx+len(markerRun):]
			continue
		}
		pOpenEnd += pOpenStart + 1 // offset just past the <w:p ...> open tag

		// Strip the marker run first; the paragraph open tag is at or
		// before pOpenStart < markerIdx so removing the run doesn't move
		// the paragraph open offsets.
		doc = doc[:markerIdx] + doc[markerIdx+len(markerRun):]

		// Build the pPrChange XML and inject into the paragraph's pPr
		// (or create a fresh pPr if absent).
		pPrChange := buildPPrChangeXML(span)
		doc = injectPPrChange(doc, pOpenStart, pOpenEnd, pPrChange)
	}
	return doc
}

// findEnclosingParagraphStart returns the offset of the <w:p tag that
// encloses the given offset, scanning backwards. Skips false-positive
// matches on <w:pPr>, <w:pStyle>, etc. by requiring the char after
// "<w:p" to be '>' or whitespace.
func findEnclosingParagraphStart(doc string, at int) int {
	off := at
	for off > 0 {
		idx := strings.LastIndex(doc[:off], "<w:p")
		if idx < 0 {
			return -1
		}
		after := idx + len("<w:p")
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

// injectPPrChange splices a <w:pPrChange> wrapper into the paragraph's
// <w:pPr>. Three pPr shapes, mirroring injectShd / injectRPrChange:
//
//  1. Paragraph already has a fully-formed <w:pPr>…</w:pPr>. Append the
//     <w:pPrChange> at the end of the pPr (Word writes pPrChange last;
//     ECMA-376 §17.13.5.29 specifies it as the final child).
//  2. Self-closing <w:pPr/>. Replace with <w:pPr><w:pPrChange .../></w:pPr>.
//  3. No <w:pPr>. Insert <w:pPr><w:pPrChange .../></w:pPr> right after
//     the paragraph's opening tag.
//
// The search for the existing pPr is scoped to the region between the
// paragraph open tag and the next <w:p ...> / </w:p> closing — without
// the bound we might match a pPr from a nested paragraph (rare in
// practice — Word paragraphs don't nest — but the discipline keeps the
// rewriter robust against future structure changes).
func injectPPrChange(doc string, pOpenStart, pOpenEnd int, pPrChange string) string {
	// Find the end of this paragraph (so the pPr search doesn't wander
	// into a sibling paragraph). </w:p> is always present in well-
	// formed docx output from WordZero.
	pCloseRel := strings.Index(doc[pOpenEnd:], "</w:p>")
	if pCloseRel < 0 {
		// Malformed — bail.
		return doc
	}
	pClose := pOpenEnd + pCloseRel
	region := doc[pOpenEnd:pClose]

	if rel := strings.Index(region, "</w:pPr>"); rel >= 0 {
		insertAt := pOpenEnd + rel
		return doc[:insertAt] + pPrChange + doc[insertAt:]
	}
	if rel := strings.Index(region, "<w:pPr/>"); rel >= 0 {
		insertAt := pOpenEnd + rel
		return doc[:insertAt] + "<w:pPr>" + pPrChange + "</w:pPr>" +
			doc[insertAt+len("<w:pPr/>"):]
	}
	// No pPr — insert a fresh one right after the paragraph open tag.
	return doc[:pOpenEnd] + "<w:pPr>" + pPrChange + "</w:pPr>" + doc[pOpenEnd:]
}

// buildPPrChangeXML formats one <w:pPrChange> element complete with
// w:id, w:author, w:date attributes and the nested <w:pPr> carrying
// the BEFORE-state pPr children. w:date is omitted when ts==0 (same
// convention as buildSuggestionOpenTag / buildRPrChangeXML).
func buildPPrChangeXML(span blockChangeSpan) string {
	body := blockStateToPPrChildren(span.BeforeType, span.BeforeAttrs)
	date := unixMsToISO8601(span.Ts)
	if date == "" {
		return fmt.Sprintf(`<w:pPrChange w:id="%d" w:author=%q><w:pPr>%s</w:pPr></w:pPrChange>`,
			span.DocxRevisionID,
			span.AuthorID,
			body)
	}
	return fmt.Sprintf(`<w:pPrChange w:id="%d" w:author=%q w:date=%q><w:pPr>%s</w:pPr></w:pPrChange>`,
		span.DocxRevisionID,
		span.AuthorID,
		date,
		body)
}
