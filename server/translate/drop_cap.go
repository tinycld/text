package translate

import (
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Drop-cap reassembly on import.
//
// PM models a drop cap as ONE paragraph with attrs.dropCap=true whose
// first character is the enlarged cap (CSS ::first-letter floats it).
// OOXML never stores it that way — there are two sources, both of which
// arrive as a PAIR of adjacent paragraphs that this pass merges into the
// single PM form:
//
//  1. Native Word drop cap. The cap sits alone in a "frame" paragraph
//     carrying <w:framePr w:dropCap="drop"/>; the body is the next
//     paragraph. The frame paragraph is tagged with the temporary
//     "_dropCapFrame" attr during parse (assembleParagraph). This pass
//     merges frame+body unconditionally for tagged paragraphs.
//
//  2. Legacy converter output (Calibre / ebook tooling). No framePr at
//     all — the cap is just a normal paragraph holding a single large-
//     font letter, followed by a paragraph that begins mid-word
//     (lowercase, no leading space). We recover these with a STRICT
//     signature match (large single uppercase letter + lowercase
//     continuation) to keep false positives near zero.
//
// In both cases the merged paragraph drops the oversized fontSize from
// the cap run (the ::first-letter CSS owns the size now) and concatenates
// the cap run with the body's runs.

// dropCapMinPx is the minimum fontSize (in CSS px, the unit the importer
// stores fontSize in — see HalfPointsToPx) a single-letter run must
// carry to be considered a legacy drop cap. 36px ≈ 27pt — comfortably
// above the largest heading (Heading1 is typically 16pt ≈ 21px) and the
// 11pt (~15px) body, so an ordinary large word never trips the
// heuristic. The two known sample docs use 58.5pt / 60pt (~78–80px).
const dropCapMinPx = 36

// mergeDropCaps walks the flat block list and folds each drop-cap pair
// (frame/cap paragraph + body paragraph) into one paragraph with
// attrs.dropCap=true. Runs as a post-pass in parseDocument alongside
// groupListParagraphs. Order: this runs BEFORE groupListParagraphs so a
// drop-cap body that happens to be followed by list paragraphs isn't
// disturbed — drop-cap paragraphs are never list items themselves.
func mergeDropCaps(blocks []PMNode) []PMNode {
	out := make([]PMNode, 0, len(blocks))
	for i := 0; i < len(blocks); i++ {
		cur := blocks[i]
		// A drop-cap pair needs a following paragraph to merge with.
		if i+1 < len(blocks) {
			next := blocks[i+1]
			if merged, ok := mergeDropCapPair(cur, next); ok {
				out = append(out, merged)
				i++ // consume the body paragraph too
				continue
			}
		}
		// Not a drop-cap cap paragraph — but it might still carry a
		// stale frame marker (a framePr drop cap with no following body,
		// which shouldn't happen but we strip defensively so the marker
		// never leaks into PM JSON).
		out = append(out, stripDropCapFrameMarker(cur))
	}
	return out
}

// mergeDropCapPair returns the merged drop-cap paragraph when (cap,
// body) form a drop-cap pair, or (_, false) otherwise. Handles both the
// native-framePr path (cap tagged with _dropCapFrame) and the strict
// legacy heuristic.
func mergeDropCapPair(cap, body PMNode) (PMNode, bool) {
	if cap.Type != NodeTypeParagraph || body.Type != NodeTypeParagraph {
		return PMNode{}, false
	}
	// The body must be a plain paragraph — not a list item, not carrying
	// its own block formatting that the cap wasn't part of. A list-item
	// paragraph carries _listNumId; reject those.
	if _, isList := body.Attrs["_listNumId"]; isList {
		return PMNode{}, false
	}

	capLetter, capRun, ok := singleLetterRun(cap)
	if !ok {
		return PMNode{}, false
	}

	_, isFrame := cap.Attrs["_dropCapFrame"]
	if !isFrame {
		// Legacy heuristic: require the cap to be a large UPPERCASE
		// letter and the body to start mid-word (lowercase, no leading
		// space). The framePr path skips these checks — Word already
		// told us it's a drop cap.
		if !unicode.IsUpper(capLetter) {
			return PMNode{}, false
		}
		if runFontSizePx(capRun) < dropCapMinPx {
			return PMNode{}, false
		}
		if !bodyStartsMidWord(body) {
			return PMNode{}, false
		}
	}

	return buildMergedDropCap(capRun, body), true
}

// singleLetterRun inspects a paragraph and, when its entire textual
// content is a single letter carried by one text run (ignoring empty
// runs Word emits as <w:r/>), returns that letter, the run node, and
// true. Image/footnote/etc. content or more than one visible character
// disqualify it.
func singleLetterRun(p PMNode) (rune, PMNode, bool) {
	var theRun PMNode
	found := false
	for _, c := range p.Content {
		switch c.Type {
		case NodeTypeText:
			if strings.TrimSpace(c.Text) == "" {
				continue // empty / whitespace-only run — skip
			}
			if found {
				return 0, PMNode{}, false // more than one non-empty run
			}
			theRun = c
			found = true
		default:
			// Any non-text inline (image, page break, note ref) means
			// this isn't a bare cap paragraph.
			return 0, PMNode{}, false
		}
	}
	if !found {
		return 0, PMNode{}, false
	}
	text := strings.TrimSpace(theRun.Text)
	if utf8.RuneCountInString(text) != 1 {
		return 0, PMNode{}, false
	}
	r, _ := utf8.DecodeRuneInString(text)
	if !unicode.IsLetter(r) {
		return 0, PMNode{}, false
	}
	return r, theRun, true
}

// runFontSizePx returns the fontSize (CSS px) carried on the run's
// textStyle mark, or 0 when absent. The importer stores fontSize as an
// "Npx" string (see the <w:sz> case in parseRunProperties).
func runFontSizePx(run PMNode) int {
	for _, m := range run.Marks {
		if m.Type != MarkTypeTextStyle {
			continue
		}
		v, ok := m.Attrs["fontSize"].(string)
		if !ok {
			return 0
		}
		return atoiPx(v)
	}
	return 0
}

// atoiPx parses an "Npx" string (e.g. "78px") to its integer px value;
// returns 0 for anything that doesn't match.
func atoiPx(s string) int {
	s = strings.TrimSuffix(strings.TrimSpace(s), "px")
	n, err := strconv.Atoi(s)
	if err != nil || n < 0 {
		return 0
	}
	return n
}

// bodyStartsMidWord reports whether the paragraph's first text run
// begins with a lowercase letter and no leading whitespace — the
// signature of a converter-flattened drop cap, where the cap letter was
// split off the front of the word ("D" + "ropcaps...").
func bodyStartsMidWord(body PMNode) bool {
	for _, c := range body.Content {
		if c.Type != NodeTypeText {
			// Leading non-text (image etc.) — not a continuation word.
			return false
		}
		if c.Text == "" {
			continue
		}
		r, _ := utf8.DecodeRuneInString(c.Text)
		if unicode.IsSpace(r) {
			return false // leading space ⇒ a normal new sentence/word
		}
		return unicode.IsLower(r)
	}
	return false
}

// buildMergedDropCap concatenates the cap run (with its oversized
// fontSize stripped) and the body's runs into one paragraph carrying
// dropCap=true. The body's own attrs (textAlign / indent) are preserved;
// the temporary _dropCapFrame marker is never copied.
func buildMergedDropCap(capRun, body PMNode) PMNode {
	content := make([]PMNode, 0, len(body.Content)+1)
	content = append(content, stripDropCapFontSize(capRun))
	content = append(content, body.Content...)

	attrs := map[string]any{"dropCap": true}
	for k, v := range body.Attrs {
		if k == "_dropCapFrame" || k == "_listNumId" || k == "_listLevel" || k == "_listFmt" {
			continue
		}
		attrs[k] = v
	}
	return PMNode{Type: NodeTypeParagraph, Attrs: attrs, Content: content}
}

// stripDropCapFontSize returns a copy of the cap run with the fontSize
// attr removed from its textStyle mark (the CSS ::first-letter render
// owns the size now). A textStyle mark left with no attrs is dropped
// entirely; other marks (color etc.) and other attrs survive.
func stripDropCapFontSize(run PMNode) PMNode {
	if len(run.Marks) == 0 {
		return run
	}
	marks := make([]PMMark, 0, len(run.Marks))
	for _, m := range run.Marks {
		if m.Type != MarkTypeTextStyle {
			marks = append(marks, m)
			continue
		}
		rest := map[string]any{}
		for k, v := range m.Attrs {
			if k == "fontSize" {
				continue
			}
			rest[k] = v
		}
		if len(rest) == 0 {
			continue // textStyle had only fontSize — drop the mark
		}
		marks = append(marks, PMMark{Type: m.Type, Attrs: rest})
	}
	out := run
	if len(marks) == 0 {
		out.Marks = nil
	} else {
		out.Marks = marks
	}
	return out
}

// stripDropCapFrameMarker removes the temporary _dropCapFrame attr from a
// paragraph that wasn't merged (defensive — keeps the marker out of PM
// JSON). Returns the node unchanged when the marker is absent.
func stripDropCapFrameMarker(n PMNode) PMNode {
	if _, ok := n.Attrs["_dropCapFrame"]; !ok {
		return n
	}
	attrs := map[string]any{}
	for k, v := range n.Attrs {
		if k == "_dropCapFrame" {
			continue
		}
		attrs[k] = v
	}
	if len(attrs) == 0 {
		n.Attrs = nil
	} else {
		n.Attrs = attrs
	}
	return n
}
