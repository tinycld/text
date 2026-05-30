package translate

import (
	"fmt"
	"strings"
)

// rewriteFormatChangeMarkers replaces every {{__pmrpr:N:anchor}} marker
// run we planted in emitTextRun with two effects:
//
//  1. Inject a <w:rPrChange> wrapper into the IMMEDIATELY-PRECEDING
//     run's <w:rPr>, carrying the BEFORE-state mark set inside a nested
//     <w:rPr>. The outer <w:rPr> stays as WordZero produced it (the
//     AFTER state Word actually renders).
//  2. Strip the marker run itself — it served only as the anchor for
//     finding the run to patch.
//
// Idempotent on the surface: a marker that's already been processed
// (e.g. because rewriteSuggestionRanges spliced new content around it)
// produces a no-op. Each marker only finds a preceding run if the
// emitter's invariant — marker is the next run after its anchored real
// run — holds. The order rewriteSuggestionRanges → rewriteFormatChangeMarkers
// matters here: the suggestion rewriter inserts <w:ins>/<w:del> tags
// AROUND runs but doesn't disturb their <w:rPr>, so the format-change
// rewriter can still walk back from a marker through the surviving
// <w:ins> wrapper to find the real run inside.
func rewriteFormatChangeMarkers(doc string, spans []formatChangeSpan) string {
	for _, span := range spans {
		markerRun, markerIdx := findMarkerRun(doc, span.Marker)
		if markerIdx < 0 {
			continue
		}
		// Locate the run immediately preceding the marker. We search
		// backwards from the marker's start for the last <w:r ...>…</w:r>
		// that closes before markerIdx.
		realRun, realIdx, realEnd := previousRunRange(doc, markerIdx)
		if realIdx < 0 {
			// No preceding run. Strip the marker and move on — the
			// rewrite degrades to "no <w:rPrChange> emitted for this
			// span" which is preferable to corrupting the document.
			doc = doc[:markerIdx] + doc[markerIdx+len(markerRun):]
			continue
		}
		patched := injectRPrChange(realRun, span)
		// Splice the patched run back, then strip the marker. We use
		// the original (realIdx, realEnd) offsets so the marker offsets
		// stay valid for the strip — patching changes only the bytes
		// between [realIdx, realEnd], so markerIdx shifts by the
		// length delta.
		delta := len(patched) - len(realRun)
		doc = doc[:realIdx] + patched + doc[realEnd:]
		// Marker offsets after the splice:
		markerIdx += delta
		doc = doc[:markerIdx] + doc[markerIdx+len(markerRun):]
	}
	return doc
}

// previousRunRange finds the last <w:r ...>…</w:r> that fully closes
// strictly before the given offset. Returns (run substring, run start
// offset, run end offset). Skips <w:rPr> / <w:rStyle> false-positive
// prefixes using the same disambiguation logic as lastRunOpen.
//
// Returns ("", -1, -1) when no preceding run is present (e.g. the
// marker is the first child of its paragraph, which would indicate a
// bug in emitTextRun — the marker is planted immediately AFTER a real
// text run that always exists).
func previousRunRange(doc string, before int) (string, int, int) {
	// Find the last </w:r> at or before `before`.
	endIdx := strings.LastIndex(doc[:before], "</w:r>")
	if endIdx < 0 {
		return "", -1, -1
	}
	runEnd := endIdx + len("</w:r>")
	// Now find the matching opener: the last <w:r> or <w:r ...> with a
	// bare-run disambiguator, before endIdx.
	openIdx := lastRunOpen(doc[:endIdx])
	if openIdx < 0 {
		return "", -1, -1
	}
	return doc[openIdx:runEnd], openIdx, runEnd
}

// injectRPrChange splices a <w:rPrChange> wrapper into the run's <w:rPr>.
// Three rPr shapes, mirroring injectVerbatimChar / injectShd:
//
//  1. Run already has a fully-formed <w:rPr>…</w:rPr>. Append the
//     <w:rPrChange> at the end of the rPr (Word writes rPrChange last;
//     ECMA-376 §17.13.5.31 specifies it as the final child).
//  2. Self-closing <w:rPr/>. Replace with <w:rPr><w:rPrChange .../></w:rPr>.
//  3. No <w:rPr>. Insert <w:rPr><w:rPrChange .../></w:rPr> right after
//     the run's opening tag.
//
// The <w:rPrChange> itself wraps a nested <w:rPr> carrying the BEFORE-
// state mark set (built from span.BeforeMarks via
// serializedMarksToRPrChildren). When BeforeMarks is empty the nested
// <w:rPr> is also empty — Word reads that as "no formatting before",
// equivalent to a plain run before the proposed change.
func injectRPrChange(run string, span formatChangeSpan) string {
	rPrChange := buildRPrChangeXML(span)
	if idx := strings.Index(run, "</w:rPr>"); idx >= 0 {
		return run[:idx] + rPrChange + run[idx:]
	}
	if idx := strings.Index(run, "<w:rPr/>"); idx >= 0 {
		return run[:idx] + "<w:rPr>" + rPrChange + "</w:rPr>" +
			run[idx+len("<w:rPr/>"):]
	}
	openEnd := strings.Index(run, ">")
	if openEnd < 0 {
		return run
	}
	return run[:openEnd+1] + "<w:rPr>" + rPrChange + "</w:rPr>" + run[openEnd+1:]
}

// buildRPrChangeXML formats one <w:rPrChange> element complete with
// w:id, w:author, w:date attributes and the nested <w:rPr> carrying
// the BEFORE-state mark children. w:date is omitted when ts==0 (same
// convention as buildSuggestionOpenTag).
func buildRPrChangeXML(span formatChangeSpan) string {
	body := serializedMarksToRPrChildren(span.BeforeMarks)
	date := unixMsToISO8601(span.Ts)
	if date == "" {
		return fmt.Sprintf(`<w:rPrChange w:id="%d" w:author=%q><w:rPr>%s</w:rPr></w:rPrChange>`,
			span.DocxRevisionID,
			span.AuthorID,
			body)
	}
	return fmt.Sprintf(`<w:rPrChange w:id="%d" w:author=%q w:date=%q><w:rPr>%s</w:rPr></w:rPrChange>`,
		span.DocxRevisionID,
		span.AuthorID,
		date,
		body)
}
