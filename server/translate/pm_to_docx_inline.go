package translate

// Inline-content emission: PM text runs + marks → docx.ParaChild slices,
// covering links (hyperlink groups), comments (range markers + reference run),
// suggestions (w:ins/w:del Revision wrappers), format changes (RPrChange),
// page breaks, footnote/endnote references, and inline images.

import (
	"fmt"
	"image/color"
	"strings"

	"github.com/nathanstitt/doctaculous/pkg/docx"
)

// inlineContent converts a paragraph's inline PM children into model children.
func (b *builder) inlineContent(nodes []PMNode) ([]docx.ParaChild, error) {
	var out []docx.ParaChild
	for _, n := range nodes {
		switch n.Type {
		case NodeTypeText:
			children, err := b.textRunChildren(n)
			if err != nil {
				return nil, err
			}
			out = append(out, children...)
		case NodeTypeImage:
			child, err := b.inlineImageChild(n)
			if err != nil {
				return nil, err
			}
			if child != nil {
				out = append(out, *child)
			}
		case NodeTypePageBreak:
			out = append(out, docx.ParaChild{Run: &docx.Run{Break: docx.BreakPage}})
		case NodeTypeFootnoteReference:
			out = append(out, b.noteReferenceChild(n, true))
		case NodeTypeEndnoteReference:
			out = append(out, b.noteReferenceChild(n, false))
		default:
			return nil, fmt.Errorf("translate: unsupported inline node %q", n.Type)
		}
	}
	return out, nil
}

// textRunChildren converts one PM text node into the model children that carry
// it: the core run (styled by its marks), optionally wrapped in a hyperlink,
// comment range markers, and suggestion (ins/del) revision wrappers. The
// wrapping order (outermost → innermost) is: suggestion Revision → comment
// range → hyperlink → run.
func (b *builder) textRunChildren(node PMNode) ([]docx.ParaChild, error) {
	if node.Text == "" {
		return nil, nil
	}

	run := docx.Run{Props: b.marksToRunProps(node.Marks), Text: node.Text}
	if change := b.formatChangeFromMarks(node.Marks); change != nil {
		run.Props.RPrChange = change
	}

	// The inner child is either a bare run or a hyperlink group wrapping it.
	var inner docx.ParaChild
	if href, anchor, has := linkTarget(node.Marks); has {
		h := &docx.Hyperlink{Runs: []docx.Run{run}}
		if anchor != "" {
			h.Anchor = anchor
		} else {
			h.Target = href
		}
		inner = docx.ParaChild{Hyperlink: h}
	} else {
		inner = docx.ParaChild{Run: &run}
	}

	// Comment ranges wrap the inner child. commentReference runs follow the
	// range end so the reader sees a well-formed range.
	commentIDs := b.commentIDsForMarks(node.Marks)
	// Suggestion (ins/del) revisions are the outermost wrapper. Nested marks
	// wrap innermost-first so the layered wrappers nest correctly.
	suggestions := b.queueSuggestionMarks(node.Marks)

	var content []docx.ParaChild
	for _, id := range commentIDs {
		content = append(content, docx.ParaChild{CommentStart: &docx.CommentMark{ID: id}})
	}
	content = append(content, inner)
	// Close comment ranges in reverse (innermost first) and emit a reference
	// run per comment.
	for i := len(commentIDs) - 1; i >= 0; i-- {
		content = append(content, docx.ParaChild{CommentEnd: &docx.CommentMark{ID: commentIDs[i]}})
		content = append(content, docx.ParaChild{Run: &docx.Run{CommentRef: commentIDs[i], HasCommentRef: true}})
	}

	// Wrap in suggestion revisions from innermost to outermost.
	for i := len(suggestions) - 1; i >= 0; i-- {
		s := suggestions[i]
		content = []docx.ParaChild{{Revision: &docx.Revision{
			Kind:    s.revisionKind(),
			ID:      s.DocxRevisionID,
			Author:  s.AuthorID,
			Date:    unixMsToISO8601(s.Ts),
			Content: content,
		}}}
	}
	return content, nil
}

// revisionKind maps a suggestion span kind to a docx.RevisionKind.
func (s suggestionSpan) revisionKind() docx.RevisionKind {
	if s.Kind == suggestionKindDelete {
		return docx.RevisionDelete
	}
	return docx.RevisionInsert
}

// marksToRunProps builds a docx.RunProps reproducing the mark → run mapping:
// bold/italic/underline; a code mark → VerbatimChar style; textStyle color /
// fontFamily / fontSize / backgroundColor; a link mark forces underline + the
// accent color (fontSize/fontFamily still apply).
func (b *builder) marksToRunProps(marks []PMMark) docx.RunProps {
	var p docx.RunProps
	hasLink := false

	for _, m := range marks {
		switch m.Type {
		case MarkTypeBold:
			p.Bold, p.HasBold = true, true
		case MarkTypeItalic:
			p.Italic, p.HasItalic = true, true
		case MarkTypeUnderline:
			p.Underline, p.HasUnderline = true, true
		case MarkTypeCode:
			p.StyleID = "VerbatimChar"
		case MarkTypeLink:
			hasLink = true
		}
	}

	for _, m := range marks {
		if m.Type != MarkTypeTextStyle {
			continue
		}
		if c, ok := m.Attrs["color"].(string); ok && c != "" {
			if rgba, ok := hexToRGBA(c); ok {
				p.Color, p.HasColor = rgba, true
			}
		}
		if f, ok := m.Attrs["fontFamily"].(string); ok && f != "" {
			p.Family = f
		}
		if px, ok := fontSizePxFromAttrs(m.Attrs); ok && px > 0 {
			if hp := PxToHalfPoints(px); hp > 0 {
				p.SizeHalfPts, p.HasSize = hp, true
			}
		}
		if bg, ok := m.Attrs["backgroundColor"].(string); ok && bg != "" {
			hex, raw, ok := normalizeBackground(bg)
			if ok {
				if rgba, ok := hexToRGBA(hex); ok {
					p.Shd = docx.Shading{Fill: rgba, HasFill: true}
				}
			} else if raw != "" {
				b.addWarning(WarningBackgroundColorLost, raw)
			}
		}
	}

	// A link forces the accent color + underline (Word's convention). fontSize
	// / fontFamily already applied above are preserved.
	if hasLink {
		p.Color, p.HasColor = linkAccentColor, true
		p.Underline, p.HasUnderline = true, true
	}
	return p
}

// normalizeBackground normalizes a textStyle backgroundColor to a 6-digit hex.
// Returns (hex, "", true) on success; ("", raw, false) when it was set but not
// normalizable (caller warns); ("", "", false) when absent-ish.
func normalizeBackground(c string) (hex, raw string, ok bool) {
	if normalized, ok := normalizeColorToHex(c); ok {
		return normalized, "", true
	}
	return "", c, false
}

// hexToRGBA parses a "#RRGGBB" / "RRGGBB" string into a color.RGBA with A=0xFF.
func hexToRGBA(s string) (color.RGBA, bool) {
	hex := strings.TrimPrefix(strings.TrimSpace(s), "#")
	if len(hex) != 6 || !isPlainHex(hex) {
		return color.RGBA{}, false
	}
	var vals [3]uint8
	for i := 0; i < 3; i++ {
		b, ok := parseHexByte(hex[i*2 : i*2+2])
		if !ok {
			return color.RGBA{}, false
		}
		vals[i] = b
	}
	return color.RGBA{R: vals[0], G: vals[1], B: vals[2], A: 0xFF}, true
}

func parseHexByte(s string) (uint8, bool) {
	var n int
	for i := 0; i < len(s); i++ {
		c := s[i]
		var d int
		switch {
		case c >= '0' && c <= '9':
			d = int(c - '0')
		case c >= 'a' && c <= 'f':
			d = int(c-'a') + 10
		case c >= 'A' && c <= 'F':
			d = int(c-'A') + 10
		default:
			return 0, false
		}
		n = n*16 + d
	}
	return uint8(n), true
}

// linkTarget resolves a link mark's href into either an external target or an
// internal anchor (leading '#'). Returns has=false when there is no link mark.
func linkTarget(marks []PMMark) (href, anchor string, has bool) {
	for _, m := range marks {
		if m.Type != MarkTypeLink {
			continue
		}
		h, ok := m.Attrs["href"].(string)
		if !ok || h == "" {
			continue
		}
		if strings.HasPrefix(h, "#") {
			return "", strings.TrimPrefix(h, "#"), true
		}
		return h, "", true
	}
	return "", "", false
}

// commentIDsForMarks allocates (or reuses) docx comment ids for the comment
// marks on a run, and records each comment body in Document.Comments. Comment
// ids number from 0.
func (b *builder) commentIDsForMarks(marks []PMMark) []int {
	var ids []int
	for _, m := range marks {
		if m.Type != MarkTypeComment {
			continue
		}
		pmID, _ := m.Attrs["id"].(string)
		var id int
		if pmID != "" {
			if existing, ok := b.commentIDByPMID[pmID]; ok {
				ids = append(ids, existing)
				continue
			}
			id = b.commentSeq
			b.commentSeq++
			b.commentIDByPMID[pmID] = id
		} else {
			id = b.commentSeq
			b.commentSeq++
		}
		if b.doc.Comments == nil {
			b.doc.Comments = map[int]*docx.Comment{}
		}
		author, _ := m.Attrs["author"].(string)
		text, _ := m.Attrs["text"].(string)
		date, _ := m.Attrs["date"].(string)
		b.doc.Comments[id] = &docx.Comment{
			ID:     id,
			Author: author,
			Date:   date,
			Body:   []docx.Block{{Paragraph: &docx.Paragraph{Content: textParaContent(text)}}},
		}
		ids = append(ids, id)
	}
	return ids
}

// textParaContent builds the single-run content of a comment body paragraph.
func textParaContent(text string) []docx.ParaChild {
	if text == "" {
		return nil
	}
	return []docx.ParaChild{{Run: &docx.Run{Text: text}}}
}

// noteReferenceChild builds a footnote/endnote reference run and registers the
// note body (+ the reserved separator notes Word expects) in the document.
func (b *builder) noteReferenceChild(node PMNode, footnote bool) docx.ParaChild {
	text, _ := node.Attrs["text"].(string)
	if footnote {
		b.footnoteSeq++
		id := b.footnoteSeq
		notes := b.ensureFootnotes()
		notes.ByID[id] = []docx.Block{{Paragraph: &docx.Paragraph{Content: textParaContent(text)}}}
		return docx.ParaChild{Run: &docx.Run{FootnoteRef: id}}
	}
	b.endnoteSeq++
	id := b.endnoteSeq
	notes := b.ensureEndnotes()
	notes.ByID[id] = []docx.Block{{Paragraph: &docx.Paragraph{Content: textParaContent(text)}}}
	return docx.ParaChild{Run: &docx.Run{EndnoteRef: id}}
}

// ensureFootnotes lazily creates Document.Footnotes and seeds the reserved
// separator notes (ids -1 and 0) Word requires.
func (b *builder) ensureFootnotes() *docx.Notes {
	if b.doc.Footnotes == nil {
		b.doc.Footnotes = docx.NewNotes()
		b.doc.Footnotes.ByID[-1] = []docx.Block{{Paragraph: &docx.Paragraph{
			Content: []docx.ParaChild{{Run: &docx.Run{NoteSep: docx.NoteSepSeparator}}}}}}
		b.doc.Footnotes.ByID[0] = []docx.Block{{Paragraph: &docx.Paragraph{
			Content: []docx.ParaChild{{Run: &docx.Run{NoteSep: docx.NoteSepContinuation}}}}}}
	}
	return b.doc.Footnotes
}

func (b *builder) ensureEndnotes() *docx.Notes {
	if b.doc.Endnotes == nil {
		b.doc.Endnotes = docx.NewNotes()
		b.doc.Endnotes.ByID[-1] = []docx.Block{{Paragraph: &docx.Paragraph{
			Content: []docx.ParaChild{{Run: &docx.Run{NoteSep: docx.NoteSepSeparator}}}}}}
		b.doc.Endnotes.ByID[0] = []docx.Block{{Paragraph: &docx.Paragraph{
			Content: []docx.ParaChild{{Run: &docx.Run{NoteSep: docx.NoteSepContinuation}}}}}}
	}
	return b.doc.Endnotes
}

// formatChangeFromMarks builds a RunPropsChange from a suggestedFormatChange
// mark. The Previous props are the before-state marks; the outer run props
// already carry the after state.
func (b *builder) formatChangeFromMarks(marks []PMMark) *docx.RunPropsChange {
	spans := b.queueFormatChangeMarks(marks)
	if len(spans) == 0 {
		return nil
	}
	// Only one rPrChange can sit inside a run's rPr; use the first span (the
	// pre-migration emitter's rewriter was likewise idempotent per run).
	s := spans[0]
	return &docx.RunPropsChange{
		Mark:     docx.RevisionMark{ID: s.DocxRevisionID, Author: s.AuthorID, Date: unixMsToISO8601(s.Ts)},
		Previous: serializedMarksToRunProps(s.BeforeMarks),
	}
}
