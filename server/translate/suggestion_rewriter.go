package translate

import (
	"fmt"
	"strings"
)

// rewriteSuggestionRanges substitutes the {{__pmsg:N:open}} /
// {{__pmsg:N:close}} marker runs we planted in emitTextRun with the
// matching <w:ins>/<w:del> opening / closing tags. For delete spans
// it also swaps every <w:t> / <w:t xml:space=...> inside the wrapped
// region for <w:delText> — docx requires deleted text to use the
// dedicated element so Word can render it as strikethrough while
// keeping the bytes recoverable on accept.
//
// Two passes:
//
//  1. Substitute every span's open/close marker run with the matching
//     <w:ins>/<w:del> ... </w:ins>/</w:del> tag. After this pass the
//     marker runs are gone and the document carries fully-balanced
//     wrappers.
//  2. For each delete span, walk the region between its open tag and
//     close tag and rewrite <w:t> → <w:delText>. Nested deletes touch
//     overlapping ranges; that's fine because the swap is idempotent
//     (after the first replacement there's no <w:t> left to rewrite).
//
// Splitting the swap into a separate pass avoids a subtle layering
// bug: if we swapped during substitution, an outer delete span's
// swap would clobber the inner span's marker run text (turning
// `<w:t>{{__pmsg:2:close}}</w:t>` into
// `<w:delText>{{__pmsg:2:close}}</w:delText>`), hiding the inner
// close from findMarkerRun.
//
// Runs without a found marker (e.g. empty text node that WordZero
// optimized away) are silently skipped — mirrors how
// rewriteCommentRanges handles missing markers.
func rewriteSuggestionRanges(doc string, spans []suggestionSpan) string {
	// Pass 1: substitute markers.
	for _, span := range spans {
		openRun, openIdx := findMarkerRun(doc, span.OpenMarker)
		if openIdx < 0 {
			continue
		}
		openTag := buildSuggestionOpenTag(span)
		doc = doc[:openIdx] + openTag + doc[openIdx+len(openRun):]

		closeRun, closeIdx := findMarkerRun(doc, span.CloseMarker)
		if closeIdx < 0 {
			continue
		}
		closeTag := closingTagFor(span.Kind)
		doc = doc[:closeIdx] + closeTag + doc[closeIdx+len(closeRun):]
	}
	// Pass 2: for each delete span, swap <w:t> → <w:delText> inside
	// its wrapper region. Idempotent so nested deletes don't conflict.
	for _, span := range spans {
		if span.Kind != suggestionKindDelete {
			continue
		}
		openTag := buildSuggestionOpenTag(span)
		closeTag := closingTagFor(span.Kind)
		openIdx := strings.Index(doc, openTag)
		if openIdx < 0 {
			continue
		}
		// Find the MATCHING close, accounting for the chance that
		// nested w:del wrappers sit between this span's open and
		// close. Each open <w:del increments depth; each close
		// decrements. Stop at depth 0.
		searchFrom := openIdx + len(openTag)
		depth := 1
		closeIdx := -1
		cursor := searchFrom
		for cursor < len(doc) {
			nextOpen := strings.Index(doc[cursor:], "<w:del ")
			nextClose := strings.Index(doc[cursor:], closeTag)
			if nextClose < 0 {
				break
			}
			if nextOpen >= 0 && nextOpen < nextClose {
				depth++
				cursor += nextOpen + len("<w:del ")
				continue
			}
			depth--
			if depth == 0 {
				closeIdx = cursor + nextClose
				break
			}
			cursor += nextClose + len(closeTag)
		}
		if closeIdx < 0 {
			continue
		}
		inner := doc[searchFrom:closeIdx]
		swapped := swapWtForWdelText(inner)
		doc = doc[:searchFrom] + swapped + doc[closeIdx:]
	}
	return doc
}

// buildSuggestionOpenTag formats one <w:ins> / <w:del> opening tag
// with the docx-mandated w:id (auto-minted per span), the w:author
// from the mark's authorId attr, and (when present) the w:date in
// ISO-8601 derived from the unix-ms ts. Author is quoted with %q so
// XML special characters get Go's standard quoted-string escaping —
// adequate for the alphanumeric userOrgId values we emit but worth
// revisiting if authors ever embed arbitrary text.
func buildSuggestionOpenTag(span suggestionSpan) string {
	tagName := "w:ins"
	if span.Kind == suggestionKindDelete {
		tagName = "w:del"
	}
	date := unixMsToISO8601(span.Ts)
	if date == "" {
		return fmt.Sprintf(`<%s w:id="%d" w:author=%q>`,
			tagName,
			span.DocxRevisionID,
			span.AuthorID)
	}
	return fmt.Sprintf(`<%s w:id="%d" w:author=%q w:date=%q>`,
		tagName,
		span.DocxRevisionID,
		span.AuthorID,
		date)
}

// closingTagFor returns the close tag matching the open kind.
func closingTagFor(kind suggestionKind) string {
	if kind == suggestionKindDelete {
		return "</w:del>"
	}
	return "</w:ins>"
}

// swapWtForWdelText rewrites every <w:t> / <w:t ...> ... </w:t> in
// the given XML fragment to use <w:delText> instead. The swap is
// purely textual: only the element name changes. Attributes on the
// element (e.g. xml:space="preserve") are preserved verbatim.
//
// We replace both the open-tag prefix and the close tag so attribute
// suffixes stay intact: a `<w:t xml:space="preserve">` becomes
// `<w:delText xml:space="preserve">`. The two replacements are
// independent — a delete span that contains zero <w:t> elements (e.g.
// only image runs) leaves the fragment unchanged.
func swapWtForWdelText(fragment string) string {
	fragment = strings.ReplaceAll(fragment, "<w:t>", "<w:delText>")
	fragment = strings.ReplaceAll(fragment, "<w:t ", "<w:delText ")
	fragment = strings.ReplaceAll(fragment, "</w:t>", "</w:delText>")
	return fragment
}
