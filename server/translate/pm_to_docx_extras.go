package translate

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// postProcessRichXML applies the page-break / comment / footnote /
// endnote rewrites that piggy-back on the marker-token strategy.
// Runs sequentially against the unzipped parts so each pass sees the
// edits the previous one made; the output is re-zipped at the end.
//
// Order matters:
//
//  1. Comment ranges (open/close markers around real content). We
//     rewrite into <w:commentRangeStart>/<w:commentReference>/
//     <w:commentRangeEnd> XML and synthesize word/comments.xml plus
//     the matching rels + [Content_Types].xml override.
//  2. Footnotes / endnotes — substitute the inline marker into
//     <w:footnoteReference> / <w:endnoteReference> and write
//     word/footnotes.xml / word/endnotes.xml as needed.
//  3. Page breaks — substitute the marker run for <w:br w:type="page"/>
//     inside its host paragraph.
//
// Each substitution is anchored on the marker text inside a <w:t>
// element, the same trick the link rewriter uses (see
// findMarkerRun). Markers are designed to be unlikely to occur in
// real text; a hostile user paste with the exact marker would
// corrupt the file but the same caveat applies to the existing link
// rewriter and is tracked in TODO.md.
func postProcessRichXML(docxBytes []byte, em *emitter) ([]byte, error) {
	zr, err := zip.NewReader(bytes.NewReader(docxBytes), int64(len(docxBytes)))
	if err != nil {
		return nil, fmt.Errorf("translate: re-read for rich postprocess: %w", err)
	}
	parts := map[string][]byte{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		buf, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			return nil, err
		}
		parts[f.Name] = buf
	}
	docXML, ok := parts["word/document.xml"]
	if !ok {
		return nil, fmt.Errorf("translate: word/document.xml missing in WordZero output")
	}
	doc := string(docXML)
	doc = rewriteCommentRanges(doc, em)
	doc = rewriteNoteReferences(doc, em.footnotes, false)
	doc = rewriteNoteReferences(doc, em.endnotes, true)
	doc = rewritePageBreaks(doc, em.pageBreaks)
	doc = rewriteDropCapFrames(doc, em.dropCapFrames)
	doc = rewriteCodeMarks(doc, em.codeMarks)
	// bgColor must run AFTER code marks: if both are present on the
	// same run, the code rewriter strips its inner markers first,
	// leaving just `<run bg-open><run real><run bg-close>` for the
	// bgColor rewriter to find unambiguously.
	doc = rewriteBgColorMarks(doc, em.bgColorSpans)
	// Suggestion ranges (<w:ins>/<w:del>) wrap their entire content,
	// including any comment range markers / reference runs the
	// previous passes already produced. Running LAST lets the
	// rewriter operate on a fully-resolved interior and apply the
	// <w:t>→<w:delText> swap with no marker-run noise in the way.
	doc = rewriteSuggestionRanges(doc, em.suggestionSpans)
	// Format-change markers (<w:rPrChange>) inject into the affected
	// run's <w:rPr>, which by now contains the after-state marks
	// WordZero produced plus any rStyle / shd the code/bg rewriters
	// added. Running after rewriteSuggestionRanges is safe because
	// the suggestion rewriter wraps runs but leaves their <w:rPr>
	// intact — and the format-change rewriter walks backwards from its
	// own marker through any wrapper to find the run's </w:r>.
	doc = rewriteFormatChangeMarkers(doc, em.formatChangeSpans)
	parts["word/document.xml"] = []byte(doc)

	if len(em.commentBodies) > 0 {
		parts["word/comments.xml"] = buildCommentsXML(em)
		parts["word/_rels/document.xml.rels"] = ensureRelOverride(
			parts["word/_rels/document.xml.rels"],
			"http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments",
			"comments.xml",
		)
		parts["[Content_Types].xml"] = ensureContentTypeOverride(
			parts["[Content_Types].xml"],
			"/word/comments.xml",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
		)
	}
	if len(em.footnotes) > 0 {
		parts["word/footnotes.xml"] = buildFootnoteLikeXML(em.footnotes, "footnotes", "footnote")
		parts["word/_rels/document.xml.rels"] = ensureRelOverride(
			parts["word/_rels/document.xml.rels"],
			"http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes",
			"footnotes.xml",
		)
		parts["[Content_Types].xml"] = ensureContentTypeOverride(
			parts["[Content_Types].xml"],
			"/word/footnotes.xml",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml",
		)
	}
	if len(em.endnotes) > 0 {
		parts["word/endnotes.xml"] = buildFootnoteLikeXML(em.endnotes, "endnotes", "endnote")
		parts["word/_rels/document.xml.rels"] = ensureRelOverride(
			parts["word/_rels/document.xml.rels"],
			"http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes",
			"endnotes.xml",
		)
		parts["[Content_Types].xml"] = ensureContentTypeOverride(
			parts["[Content_Types].xml"],
			"/word/endnotes.xml",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml",
		)
	}
	// Suggestion metadata is stashed in a custom XML part (Word ignores
	// unknown namespaces; tinycld readers parse it back to repopulate
	// the suggestions Y.Map). We add the part whenever the emitter saw
	// suggestion spans OR the caller passed entries — either side alone
	// is useful: spans without entries still publish the (w:id →
	// suggestionId) mapping; entries without spans (degenerate but
	// possible) keep the metadata for any future reconciliation.
	if len(em.suggestionSpans) > 0 || len(em.formatChangeSpans) > 0 || len(em.suggestionEntries) > 0 {
		xmlBytes, err := writeSuggestionsCustomXML(em.suggestionSpans, em.formatChangeSpans, em.suggestionEntries)
		if err != nil {
			return nil, fmt.Errorf("translate: build suggestions custom xml: %w", err)
		}
		parts["customXml/tinycld-suggestions.xml"] = xmlBytes
		parts["[Content_Types].xml"] = ensureContentTypeOverride(
			parts["[Content_Types].xml"],
			"/customXml/tinycld-suggestions.xml",
			"application/xml",
		)
	}
	return rezipParts(zr, parts)
}

// rewritePageBreaks finds each {{__pmpb:N}} marker run in document.xml
// and replaces the whole run with a bare <w:r><w:br w:type="page"/></w:r>.
// That keeps the break inside the host paragraph (where WordZero
// originally placed the marker text run) — Word renders the break and
// the surrounding text on either side flows naturally.
func rewritePageBreaks(doc string, breaks []pageBreakMarker) string {
	for _, b := range breaks {
		run, idx := findMarkerRun(doc, b.Marker)
		if idx < 0 {
			continue
		}
		doc = doc[:idx] + `<w:r><w:br w:type="page"/></w:r>` + doc[idx+len(run):]
	}
	return doc
}

// rewriteDropCapFrames turns each drop-cap cap paragraph into a Word
// native drop cap. The emitter planted a {{__pmdc:N}} marker run as the
// FIRST run of the cap paragraph (see emitDropCapParagraph). For each
// marker we:
//  1. strip the marker run, then
//  2. inject <w:framePr w:dropCap="drop" w:lines="3"/> into the
//     enclosing <w:p>'s <w:pPr> (creating the pPr if absent).
//
// WordZero's ParagraphProperties has no framePr field, so this XML-layer
// splice is the only way to attach it without forking the dependency.
func rewriteDropCapFrames(doc string, frames []dropCapFrame) string {
	for _, f := range frames {
		run, idx := findMarkerRun(doc, f.Marker)
		if idx < 0 {
			continue
		}
		// Strip the marker run first; the paragraph open tag is at or
		// before idx, so removing the run doesn't move it.
		doc = doc[:idx] + doc[idx+len(run):]
		doc = injectFramePrBefore(doc, idx)
	}
	return doc
}

// injectFramePrBefore finds the <w:p ...> that encloses the offset
// `at` (scanning backwards from it) and injects a drop-cap framePr into
// that paragraph's properties. Three pPr shapes are handled, mirroring
// injectShd: an existing <w:pPr>…</w:pPr> (append framePr — Word wants
// framePr early in pPr, but readers tolerate it after pStyle), a self-
// closing <w:pPr/>, or no pPr at all (insert one right after the <w:p>
// open tag). Returns the doc unchanged when no enclosing <w:p> is found.
func injectFramePrBefore(doc string, at int) string {
	const framePr = `<w:framePr w:dropCap="drop" w:lines="3"/>`
	pOpenStart := strings.LastIndex(doc[:at], "<w:p")
	// Guard against matching <w:pPr> / <w:pStyle> etc.: require the char
	// after "<w:p" to be '>' or whitespace (a bare paragraph open tag).
	for pOpenStart >= 0 {
		after := pOpenStart + len("<w:p")
		if after < len(doc) {
			c := doc[after]
			if c == '>' || c == ' ' || c == '\t' || c == '\n' || c == '\r' {
				break
			}
		}
		pOpenStart = strings.LastIndex(doc[:pOpenStart], "<w:p")
	}
	if pOpenStart < 0 {
		return doc
	}
	pOpenEnd := strings.Index(doc[pOpenStart:], ">")
	if pOpenEnd < 0 {
		return doc
	}
	pOpenEnd += pOpenStart + 1 // offset just past the <w:p ...> open tag

	// Search for a pPr only within this paragraph (up to the marker
	// offset `at`, which sits inside this same paragraph's run list).
	region := doc[pOpenEnd:at]
	if rel := strings.Index(region, "</w:pPr>"); rel >= 0 {
		insertAt := pOpenEnd + rel
		return doc[:insertAt] + framePr + doc[insertAt:]
	}
	if rel := strings.Index(region, "<w:pPr/>"); rel >= 0 {
		insertAt := pOpenEnd + rel
		return doc[:insertAt] + "<w:pPr>" + framePr + "</w:pPr>" +
			doc[insertAt+len("<w:pPr/>"):]
	}
	// No pPr — insert a fresh one right after the paragraph open tag.
	return doc[:pOpenEnd] + "<w:pPr>" + framePr + "</w:pPr>" + doc[pOpenEnd:]
}

// rewriteNoteReferences substitutes footnote / endnote marker runs
// into proper reference elements. The endnote bool flips the element
// names; the rest of the logic is shared.
func rewriteNoteReferences(doc string, notes []footnoteEntry, endnote bool) string {
	tag := "footnoteReference"
	if endnote {
		tag = "endnoteReference"
	}
	for _, n := range notes {
		run, idx := findMarkerRun(doc, n.Marker)
		if idx < 0 {
			continue
		}
		// Wrap the reference in a run so its presence inside a paragraph
		// stays well-formed. <w:rPr><w:rStyle> picks up Word's
		// FootnoteReference / EndnoteReference character styles when
		// the document defines them; absent the style the runs render
		// as plain superscript digits, still semantically correct.
		ref := `<w:r><w:rPr><w:rStyle w:val="` + capitalize(tag) + `"/></w:rPr>` +
			`<w:` + tag + ` w:id="` + n.ID + `"/></w:r>`
		doc = doc[:idx] + ref + doc[idx+len(run):]
	}
	return doc
}

func capitalize(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// rewriteCommentRanges rewrites {{__pmcm:N:open}} / {{__pmcm:N:close}}
// pairs into <w:commentRangeStart w:id="N"/> / <w:commentRangeEnd
// w:id="N"/><w:r><w:commentReference w:id="N"/></w:r>. The reference
// run is attached at the close site so Word renders the reference pill
// at the end of the highlighted text — matching what Word produces
// when you add a comment via the UI.
func rewriteCommentRanges(doc string, em *emitter) string {
	for _, span := range em.commentSpans {
		openRun, openIdx := findMarkerRun(doc, span.OpenMarker)
		if openIdx < 0 {
			continue
		}
		doc = doc[:openIdx] + `<w:commentRangeStart w:id="` + span.ID + `"/>` +
			doc[openIdx+len(openRun):]
		closeRun, closeIdx := findMarkerRun(doc, span.CloseMarker)
		if closeIdx < 0 {
			continue
		}
		doc = doc[:closeIdx] + `<w:commentRangeEnd w:id="` + span.ID + `"/>` +
			`<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr>` +
			`<w:commentReference w:id="` + span.ID + `"/></w:r>` +
			doc[closeIdx+len(closeRun):]
	}
	return doc
}

// rewriteCodeMarks turns each open/close marker pair into a
// <w:rStyle w:val="VerbatimChar"/> stamped onto the surviving real
// run's <w:rPr>. The two marker runs themselves are spliced out.
//
// WordZero's RunProperties struct doesn't expose an rStyle field, so
// this is the only way to attach the character style we want without
// forking the dependency. The middle run is the one between the
// open marker run and the close marker run; we either extend its
// existing <w:rPr> (when bold/italic/etc. marks are already present)
// or insert a fresh <w:rPr> right after the opening <w:r ...> tag.
func rewriteCodeMarks(doc string, marks []codeMarkSpan) string {
	for _, span := range marks {
		openRun, openIdx := findMarkerRun(doc, span.OpenMarker)
		if openIdx < 0 {
			continue
		}
		// Strip the open marker. Subsequent searches must be relative
		// to the post-strip document, so we splice first and then
		// search for the next two runs starting at the open index.
		doc = doc[:openIdx] + doc[openIdx+len(openRun):]
		// The very next <w:r ...>…</w:r> at openIdx is the real run.
		realRun, realIdx := nextRunRun(doc, openIdx)
		if realIdx < 0 {
			continue
		}
		patched := injectVerbatimChar(realRun)
		doc = doc[:realIdx] + patched + doc[realIdx+len(realRun):]
		// Locate and strip the close marker.
		closeRun, closeIdx := findMarkerRun(doc, span.CloseMarker)
		if closeIdx < 0 {
			continue
		}
		doc = doc[:closeIdx] + doc[closeIdx+len(closeRun):]
	}
	return doc
}

// rewriteBgColorMarks finds each open-marker run, locates the next
// real run after it, splices a <w:shd> element into that run's
// <w:rPr>, then strips the close marker. Mirrors rewriteCodeMarks
// structurally — the only difference is which element we inject and
// that the hex value comes from the span (not a constant).
func rewriteBgColorMarks(doc string, spans []bgColorSpan) string {
	for _, span := range spans {
		openRun, openIdx := findMarkerRun(doc, span.OpenMarker)
		if openIdx < 0 {
			continue
		}
		doc = doc[:openIdx] + doc[openIdx+len(openRun):]
		realRun, realIdx := nextRunRun(doc, openIdx)
		if realIdx < 0 {
			continue
		}
		patched := injectShd(realRun, span.Hex)
		doc = doc[:realIdx] + patched + doc[realIdx+len(realRun):]
		closeRun, closeIdx := findMarkerRun(doc, span.CloseMarker)
		if closeIdx < 0 {
			continue
		}
		doc = doc[:closeIdx] + doc[closeIdx+len(closeRun):]
	}
	return doc
}

// injectShd splices `<w:shd w:val="clear" w:color="auto" w:fill="HEX"/>`
// into the run's <w:rPr>. Same three-shape logic as injectVerbatimChar.
// We append the shd inside the rPr rather than prepending so that
// existing color / underline / etc. ordering is preserved (Word emits
// shd late in the rPr child list; some readers are picky about order).
func injectShd(run, hex string) string {
	shd := `<w:shd w:val="clear" w:color="auto" w:fill="` + hex + `"/>`
	if idx := strings.Index(run, "</w:rPr>"); idx >= 0 {
		return run[:idx] + shd + run[idx:]
	}
	if idx := strings.Index(run, "<w:rPr/>"); idx >= 0 {
		return run[:idx] + "<w:rPr>" + shd + "</w:rPr>" + run[idx+len("<w:rPr/>"):]
	}
	openEnd := strings.Index(run, ">")
	if openEnd < 0 {
		return run
	}
	return run[:openEnd+1] + "<w:rPr>" + shd + "</w:rPr>" + run[openEnd+1:]
}

// nextRunRun returns the first <w:r ...>…</w:r> element starting at
// or after the given offset. Unlike findMarkerRun, it doesn't anchor
// on a known marker text — used by rewriteCodeMarks to locate the
// real run that the markers flank. Returns ("", -1) if no run is
// found.
func nextRunRun(doc string, fromOffset int) (string, int) {
	if fromOffset < 0 || fromOffset >= len(doc) {
		return "", -1
	}
	rest := doc[fromOffset:]
	// Look for "<w:r" followed by "/", ">", or whitespace — same
	// constraint lastRunOpen uses, to avoid matching <w:rPr>, <w:rStyle>,
	// etc.
	i := 0
	for i < len(rest) {
		idx := strings.Index(rest[i:], "<w:r")
		if idx < 0 {
			return "", -1
		}
		idx += i
		if idx+4 >= len(rest) {
			return "", -1
		}
		next := rest[idx+4]
		if next == '>' || next == ' ' || next == '\t' || next == '\n' || next == '\r' || next == '/' {
			endRel := strings.Index(rest[idx:], "</w:r>")
			if endRel < 0 {
				return "", -1
			}
			runEnd := idx + endRel + len("</w:r>")
			return rest[idx:runEnd], fromOffset + idx
		}
		i = idx + 4
	}
	return "", -1
}

// injectVerbatimChar splices `<w:rStyle w:val="VerbatimChar"/>` into
// the run's <w:rPr>. Three shapes to handle:
//
//  1. Run already has a fully-formed <w:rPr>…</w:rPr> — prepend the
//     rStyle inside it so the style appears before any toggle marks
//     (matches Word's authoring order, which puts style refs first).
//  2. Run has a self-closing <w:rPr/> — replace with a fully-formed
//     <w:rPr> wrapping just the rStyle.
//  3. Run has no <w:rPr> at all — insert one right after the opening
//     <w:r ...> tag.
//
// We accept the run substring (e.g. `<w:r><w:t>foo</w:t></w:r>`) and
// return it modified. Unrecognised shapes return the input unchanged.
func injectVerbatimChar(run string) string {
	const rStyle = `<w:rStyle w:val="VerbatimChar"/>`
	if idx := strings.Index(run, "</w:rPr>"); idx >= 0 {
		// Find the matching opener so we know where to splice.
		if open := strings.Index(run, "<w:rPr>"); open >= 0 && open < idx {
			return run[:open+len("<w:rPr>")] + rStyle + run[open+len("<w:rPr>"):]
		}
	}
	if idx := strings.Index(run, "<w:rPr/>"); idx >= 0 {
		return run[:idx] + "<w:rPr>" + rStyle + "</w:rPr>" + run[idx+len("<w:rPr/>"):]
	}
	// No <w:rPr> at all. Insert right after the run's opening tag.
	openEnd := strings.Index(run, ">")
	if openEnd < 0 {
		return run
	}
	return run[:openEnd+1] + "<w:rPr>" + rStyle + "</w:rPr>" + run[openEnd+1:]
}

// buildCommentsXML serializes em.commentBodies into a fresh
// word/comments.xml part. We iterate em.commentSpans for ordering so
// the XML matches document.xml's traversal order — not strictly
// required by the spec but easier to read.
func buildCommentsXML(em *emitter) []byte {
	var sb strings.Builder
	sb.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`)
	sb.WriteString(`<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`)
	seen := map[string]bool{}
	for _, span := range em.commentSpans {
		if seen[span.ID] {
			continue
		}
		seen[span.ID] = true
		body := em.commentBodies[span.ID]
		sb.WriteString(`<w:comment w:id="`)
		sb.WriteString(body.ID)
		sb.WriteString(`"`)
		if body.Author != "" {
			sb.WriteString(` w:author="`)
			sb.WriteString(xmlEscape(body.Author))
			sb.WriteString(`"`)
		}
		if body.Date != "" {
			sb.WriteString(` w:date="`)
			sb.WriteString(xmlEscape(body.Date))
			sb.WriteString(`"`)
		}
		sb.WriteString(`><w:p><w:r><w:t xml:space="preserve">`)
		sb.WriteString(xmlEscape(body.Text))
		sb.WriteString(`</w:t></w:r></w:p></w:comment>`)
	}
	sb.WriteString(`</w:comments>`)
	return []byte(sb.String())
}

// buildFootnoteLikeXML serializes an entries list into footnotes.xml
// or endnotes.xml. Each user note becomes one <w:footnote|endnote>;
// we also seed the reserved id="-1" separator and id="0" continuation
// separator entries Word expects — without them, Word complains
// during open and may discard the part.
func buildFootnoteLikeXML(entries []footnoteEntry, rootName, itemName string) []byte {
	var sb strings.Builder
	sb.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`)
	sb.WriteString(`<w:`)
	sb.WriteString(rootName)
	sb.WriteString(` xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`)
	sb.WriteString(`<w:`)
	sb.WriteString(itemName)
	sb.WriteString(` w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:`)
	sb.WriteString(itemName)
	sb.WriteString(`>`)
	sb.WriteString(`<w:`)
	sb.WriteString(itemName)
	sb.WriteString(` w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:`)
	sb.WriteString(itemName)
	sb.WriteString(`>`)
	for _, e := range entries {
		sb.WriteString(`<w:`)
		sb.WriteString(itemName)
		sb.WriteString(` w:id="`)
		sb.WriteString(e.ID)
		sb.WriteString(`"><w:p><w:r><w:t xml:space="preserve">`)
		sb.WriteString(xmlEscape(e.Text))
		sb.WriteString(`</w:t></w:r></w:p></w:`)
		sb.WriteString(itemName)
		sb.WriteString(`>`)
	}
	sb.WriteString(`</w:`)
	sb.WriteString(rootName)
	sb.WriteString(`>`)
	return []byte(sb.String())
}

// ensureRelOverride adds a relationship row mapping the given target
// part name into document.xml.rels if one isn't already present. Each
// part gets a fresh rId (chosen via nextRid). Idempotent — repeated
// calls with the same target are no-ops.
func ensureRelOverride(rels []byte, relType, target string) []byte {
	relsStr := string(rels)
	if relsStr == "" {
		// Synthesize a minimal rels file. Shouldn't happen in practice —
		// WordZero always emits one — but the defensive branch keeps
		// the function safely idempotent.
		relsStr = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
			`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`
	}
	if strings.Contains(relsStr, `Target="`+target+`"`) {
		return []byte(relsStr)
	}
	rid := "rId" + strconv.Itoa(nextRid(relsStr))
	row := `<Relationship Id="` + rid + `" Type="` + relType + `" Target="` + target + `"/>`
	closeTag := "</Relationships>"
	idx := strings.LastIndex(relsStr, closeTag)
	if idx < 0 {
		return []byte(relsStr)
	}
	return []byte(relsStr[:idx] + row + relsStr[idx:])
}

// ensureContentTypeOverride adds an <Override> row to
// [Content_Types].xml mapping the given part name onto a content
// type. Idempotent — repeated calls with the same part name are
// no-ops.
func ensureContentTypeOverride(ct []byte, partName, contentType string) []byte {
	ctStr := string(ct)
	if strings.Contains(ctStr, `PartName="`+partName+`"`) {
		return []byte(ctStr)
	}
	row := `<Override PartName="` + partName + `" ContentType="` + contentType + `"/>`
	closeTag := "</Types>"
	idx := strings.LastIndex(ctStr, closeTag)
	if idx < 0 {
		return []byte(ctStr)
	}
	return []byte(ctStr[:idx] + row + ctStr[idx:])
}
