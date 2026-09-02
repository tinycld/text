package translate

import (
	"encoding/base64"
	"fmt"
	"image/color"
	"path"
	"strconv"
	"strings"

	"github.com/nathanstitt/omnidoc/pkg/docx"
)

// This file holds the omnidoc-model walk that replaces the hand-rolled
// encoding/xml producers. docx.OpenBytes gives a fully-parsed *docx.Document;
// we walk its Body into the same intermediate PM paragraphs the legacy parser
// produced, then run the identical PM-tree post-passes (list grouping, vmerge
// consolidation, drop-cap merge, inline-image lifting) that live in
// docx_to_pm.go. Only the producers changed; the post-passes are untouched.

// walkDocument is the model-walk equivalent of the legacy parseDocument: it
// turns a parsed *docx.Document into the doc-level PMNode, applying the same
// mergeDropCaps -> groupListParagraphs -> renestInterruptingBulletSubLists
// pipeline over the flat block list.
func (p *docxParser) walkDocument(doc *docx.Document) PMNode {
	root := PMNode{Type: NodeTypeDoc}
	var flat []PMNode
	for i := range doc.Body {
		node := p.walkBlock(doc.Body[i])
		if node != nil {
			flat = append(flat, liftInlineImages(*node)...)
		}
	}
	root.Content = renestInterruptingBulletSubLists(groupListParagraphs(mergeDropCaps(flat)))
	return root
}

// walkBlock dispatches one body/cell block: a paragraph or a table. (SectPr,
// bookmarks, sdt, etc. are already resolved/unwrapped by omnidoc at parse
// time, so there is no dispatch for them here.)
func (p *docxParser) walkBlock(blk docx.Block) *PMNode {
	switch {
	case blk.Paragraph != nil:
		return p.walkParagraph(blk.Paragraph)
	case blk.Table != nil:
		return p.walkTable(blk.Table)
	default:
		return nil
	}
}

// walkParagraph derives the same eight assembleParagraph inputs from a parsed
// paragraph's properties, walks its inline content into runs, and hands off to
// the (preserved) assembleParagraph.
func (p *docxParser) walkParagraph(para *docx.Paragraph) *PMNode {
	pStyle, numID, ilvl, textAlign, indentLevel, dropCapFrame, blockChange := p.paraPropsFields(para.Props)
	runs := p.walkParaContent(para.Content)
	return p.assembleParagraph(pStyle, numID, ilvl, textAlign, indentLevel, dropCapFrame, blockChange, runs)
}

// paraPropsFields extracts, from a parsed ParagraphProps, the same values the
// legacy parseParagraphProperties wrote into its out-params. Justify/indent are
// re-mapped from omnidoc's typed forms onto the PM string/level encodings.
func (p *docxParser) paraPropsFields(props docx.ParagraphProps) (pStyle, numID, ilvl, textAlign string, indentLevel int, dropCapFrame bool, blockChange map[string]any) {
	pStyle = props.StyleID
	if props.HasNum {
		numID = strconv.Itoa(props.NumID)
		ilvl = strconv.Itoa(props.ILvl)
	}
	if props.HasJustify {
		textAlign = justifyToTextAlign(props.Justify)
	}
	if props.HasIndentLeft {
		indentLevel = twipsToIndentLevelInt(int(props.IndentLeft))
	}
	if props.Frame != nil && (props.Frame.DropCap == "drop" || props.Frame.DropCap == "margin") {
		dropCapFrame = true
	}
	if props.PPrChange != nil {
		blockChange = p.blockChangeFromModel(props.PPrChange)
	}
	return
}

// justifyToTextAlign maps omnidoc's Justify enum onto the PM textAlign enum.
// Mirrors normalizeJustification's output for the equivalent OOXML values.
func justifyToTextAlign(j docx.Justify) string {
	switch j {
	case docx.JustifyCenter:
		return "center"
	case docx.JustifyRight:
		return "right"
	case docx.JustifyBoth:
		return "justify"
	default:
		return "left"
	}
}

// blockChangeFromModel builds the half-filled suggestedBlockChange attr from a
// parsed w:pPrChange (Mark + Previous ParagraphProps). The AFTER state is filled
// by assembleParagraph, exactly as in the legacy path.
func (p *docxParser) blockChangeFromModel(ch *docx.ParaPropsChange) map[string]any {
	suggestionID := p.suggestionMapping.BlockChange[ch.Mark.ID]
	if suggestionID == "" {
		suggestionID = fmt.Sprintf("docx:ppr:%d:%s", ch.Mark.ID, ch.Mark.Author)
	}
	bPStyle, bNumID, bIlvl, bTextAlign, bIndent, _, _ := p.paraPropsFields(ch.Previous)
	beforeType, beforeAttrs := p.resolveBlockTypeFromPPr(bPStyle, bNumID, bIlvl, bTextAlign, bIndent)
	return map[string]any{
		"suggestionId": suggestionID,
		"authorId":     ch.Mark.Author,
		"ts":           float64(parseISO8601ToUnixMs(ch.Mark.Date)),
		"before": map[string]any{
			"type":  beforeType,
			"attrs": beforeAttrs,
		},
	}
}

// walkParaContent walks a paragraph's inline children into a flat []PMNode of
// text/image/pageBreak/footnoteRef runs, maintaining the same open-comment and
// active-suggestion cursors the legacy streaming parser used.
func (p *docxParser) walkParaContent(content []docx.ParaChild) []PMNode {
	var runs []PMNode
	for i := range content {
		p.walkParaChild(content[i], &runs, nil)
	}
	return runs
}

// walkParaChild handles one inline child. extraMarks carries hyperlink-imposed
// marks down onto nested runs (as the legacy parseRun's extras did).
func (p *docxParser) walkParaChild(c docx.ParaChild, runs *[]PMNode, extraMarks []PMMark) {
	switch {
	case c.Run != nil:
		p.walkRun(*c.Run, runs, extraMarks)
	case c.Hyperlink != nil:
		p.walkHyperlink(c.Hyperlink, runs)
	case c.Drawing != nil:
		if img := p.walkDrawing(c.Drawing); img != nil {
			// A bare drawing sibling flushes as an image run carrying only the
			// active comment/suggestion marks (never text-format marks).
			p.flushImage(runs, *img)
		}
	case c.Revision != nil:
		markType := MarkTypeSuggestedInsert
		if c.Revision.Kind == docx.RevisionDelete {
			markType = MarkTypeSuggestedDelete
		}
		p.pushSuggestionFromRevision(markType, c.Revision)
		for i := range c.Revision.Content {
			p.walkParaChild(c.Revision.Content[i], runs, extraMarks)
		}
		p.popSuggestion()
	case c.CommentStart != nil:
		p.openComments = append(p.openComments, strconv.Itoa(c.CommentStart.ID))
	case c.CommentEnd != nil:
		p.closeComment(strconv.Itoa(c.CommentEnd.ID))
	}
}

// flushImage appends an image node, layering the active comment/suggestion marks
// the same way flushRun does for a run's non-text nodes (images carry no marks
// in the legacy path, so we append none of the format marks here either).
func (p *docxParser) flushImage(out *[]PMNode, img PMNode) {
	*out = append(*out, img)
}

// walkRun converts a parsed run into PM nodes. omnidoc splits a w:r on an
// embedded break, so one Run carries at most one Break plus its text; we emit
// the text (if any) and then the break node, applying the run's marks via the
// preserved flushRun.
func (p *docxParser) walkRun(r docx.Run, out *[]PMNode, extraMarks []PMMark) {
	marks := runPropsToMarks(p, r.Props)
	var collected []PMNode
	if r.FootnoteRef != 0 {
		collected = append(collected, p.noteRefNode(NodeTypeFootnoteReference, r.FootnoteRef, p.footnotes))
	}
	if r.EndnoteRef != 0 {
		collected = append(collected, p.noteRefNode(NodeTypeEndnoteReference, r.EndnoteRef, p.endnotes))
	}
	if r.Text != "" {
		collected = append(collected, PMNode{Type: NodeTypeText, Text: r.Text})
	}
	switch r.Break {
	case docx.BreakPage:
		collected = append(collected, PMNode{Type: NodeTypePageBreak})
	case docx.BreakLine, docx.BreakColumn:
		collected = append(collected, PMNode{Type: NodeTypeText, Text: "\n"})
	}
	_ = p.flushRun(out, collected, marks, extraMarks)
}

// noteRefNode builds a footnote/endnote reference PM node, stamping the note's
// flattened body text (from the note-body map) when known — matching the legacy
// text attr.
func (p *docxParser) noteRefNode(nodeType string, id int, bodies map[string]string) PMNode {
	ref := PMNode{Type: nodeType}
	idStr := strconv.Itoa(id)
	attrs := map[string]any{"id": idStr}
	if txt, ok := bodies[idStr]; ok {
		attrs["text"] = txt
	}
	ref.Attrs = attrs
	return ref
}

// walkHyperlink resolves the link href (external target, else #anchor) and walks
// the link's runs with a link mark layered on, mirroring parseHyperlink.
func (p *docxParser) walkHyperlink(h *docx.Hyperlink, runs *[]PMNode) {
	href := h.Target
	if href == "" && h.RelID != "" {
		if rel, ok := p.docRels[h.RelID]; ok {
			href = rel.Target
		}
	}
	if href == "" && h.Anchor != "" {
		href = "#" + h.Anchor
	}
	var extra []PMMark
	if href != "" {
		extra = []PMMark{{Type: MarkTypeLink, Attrs: map[string]any{"href": href}}}
	}
	for i := range h.Runs {
		p.walkRun(h.Runs[i], runs, extra)
	}
}

// walkDrawing converts a parsed Drawing into a PM image node, embedding the media
// bytes as a data: URI. Mirrors parseDrawing: alt from Description, title from
// Title, wrap from Anchored/WrapKind/AlignH, dimensions from the EMU extent.
func (p *docxParser) walkDrawing(dr *docx.Drawing) *PMNode {
	if dr.RelID == "" {
		return nil
	}
	src := p.mediaSrc(dr.RelID)
	if src == "" {
		return nil
	}
	img := &PMNode{Type: NodeTypeImage, Attrs: map[string]any{"src": src}}
	if dr.Description != "" && dr.Description != wordZeroDefaultImageLabel {
		img.Attrs["alt"] = dr.Description
	}
	if dr.Title != "" && dr.Title != wordZeroDefaultImageLabel {
		img.Attrs["title"] = dr.Title
	}
	if wrap := wrapFromModel(dr); wrap != "" {
		img.Attrs["wrap"] = wrap
	}
	if dr.WidthEMU > 0 {
		img.Attrs["width"] = emusToPixels(int(dr.WidthEMU))
	}
	if dr.HeightEMU > 0 {
		img.Attrs["height"] = emusToPixels(int(dr.HeightEMU))
	}
	return img
}

// wrapFromModel maps the parsed drawing's Anchored/WrapKind/AlignH onto the PM
// `wrap` attr via the preserved resolveWrap. Inline drawings (Anchored=false)
// produce no wrap; "none"/"topAndBottom"/text-flow modes map as before.
func wrapFromModel(dr *docx.Drawing) string {
	if !dr.Anchored {
		return ""
	}
	hasTopAndBottom := dr.WrapKind == "topAndBottom"
	hasWrap := dr.WrapKind == "square" || dr.WrapKind == "tight" || dr.WrapKind == "through"
	return resolveWrap(true, hasWrap, hasTopAndBottom, dr.AlignH)
}

// mediaSrc resolves a drawing's relationship id to a self-contained data: URI,
// reading the media bytes from the pre-loaded Document.Media map. Returns "" when
// the relationship or media part is missing.
func (p *docxParser) mediaSrc(relID string) string {
	rel, ok := p.docRels[relID]
	if !ok || rel.Target == "" {
		return ""
	}
	// omnidoc resolves rel targets to full part names (word/media/imageN.png).
	target := strings.TrimPrefix(path.Clean(rel.Target), "/")
	data, ok := p.media[target]
	if !ok {
		// Some producers write the target relative to the part dir; retry with
		// the word/ prefix the legacy resolver assumed.
		if d, ok2 := p.media[strings.TrimPrefix(path.Clean(path.Join("word", rel.Target)), "/")]; ok2 {
			data = d
		} else {
			return ""
		}
	}
	return "data:" + mimeFromExt(path.Ext(target)) + ";base64," +
		base64.StdEncoding.EncodeToString(data)
}

// pushSuggestionFromRevision builds and pushes a suggestion mark from a parsed
// Revision (the model equivalent of pushSuggestion's OOXML-element reading).
func (p *docxParser) pushSuggestionFromRevision(markType string, rev *docx.Revision) {
	suggestionID := ""
	switch markType {
	case MarkTypeSuggestedInsert:
		suggestionID = p.suggestionMapping.Insert[rev.ID]
	case MarkTypeSuggestedDelete:
		suggestionID = p.suggestionMapping.Delete[rev.ID]
	}
	if suggestionID == "" {
		suggestionID = fmt.Sprintf("docx:%d:%s", rev.ID, rev.Author)
	}
	p.activeSuggestions = append(p.activeSuggestions, PMMark{
		Type: markType,
		Attrs: map[string]any{
			"suggestionId": suggestionID,
			"authorId":     rev.Author,
			"ts":           float64(parseISO8601ToUnixMs(rev.Date)),
		},
	})
}

// runPropsToMarks is the model-walk equivalent of parseRunProperties: it turns a
// parsed RunProps into the same PM marks (bold/italic/underline/code + a single
// textStyle mark bundling color/backgroundColor/fontSize/fontFamily), plus a
// suggestedFormatChange mark when an rPrChange is present.
func runPropsToMarks(p *docxParser, rp docx.RunProps) []PMMark {
	var marks []PMMark
	if rp.HasBold && rp.Bold {
		marks = append(marks, PMMark{Type: MarkTypeBold})
	}
	if rp.HasItalic && rp.Italic {
		marks = append(marks, PMMark{Type: MarkTypeItalic})
	}
	if rp.HasUnderline && rp.Underline {
		marks = append(marks, PMMark{Type: MarkTypeUnderline})
	}
	if rp.StyleID == "VerbatimChar" || rp.StyleID == "Code" {
		marks = append(marks, PMMark{Type: MarkTypeCode})
	}

	textStyleAttrs := map[string]any{}
	if rp.HasColor && !isAutoColor(rp.Color) {
		textStyleAttrs["color"] = "#" + strings.ToUpper(rgbHex(rp.Color))
	}
	// shd wins over highlight (more precise); highlight only fills the gap.
	if rp.Shd.HasFill {
		textStyleAttrs["backgroundColor"] = "#" + strings.ToUpper(rgbHex(rp.Shd.Fill))
	} else if rp.HasHighlight {
		// Use the original highlight name against text's palette so the output
		// hex matches the legacy parser (omnidoc's RGBA uses different hexes
		// for several names).
		if hex := highlightNameToHex(rp.HighlightName); hex != "" {
			textStyleAttrs["backgroundColor"] = hex
		}
	}
	if rp.HasSize && rp.SizeHalfPts > 0 {
		if px := HalfPointsToPx(rp.SizeHalfPts); px > 0 {
			textStyleAttrs["fontSize"] = strconv.Itoa(px) + "px"
		}
	}
	if rp.Family != "" {
		textStyleAttrs["fontFamily"] = rp.Family
	}
	if len(textStyleAttrs) > 0 {
		marks = append(marks, PMMark{Type: MarkTypeTextStyle, Attrs: textStyleAttrs})
	}

	if rp.RPrChange != nil {
		marks = append(marks, formatChangeMarkFromModel(p, rp.RPrChange, marks))
	}
	return marks
}

// formatChangeMarkFromModel builds a suggestedFormatChange mark: before = the
// marks of the Previous run props; after = the already-collected AFTER marks.
func formatChangeMarkFromModel(p *docxParser, ch *docx.RunPropsChange, afterMarks []PMMark) PMMark {
	suggestionID := p.suggestionMapping.FormatChange[ch.Mark.ID]
	if suggestionID == "" {
		suggestionID = fmt.Sprintf("docx:rpr:%d:%s", ch.Mark.ID, ch.Mark.Author)
	}
	before := runPropsToMarks(p, ch.Previous)
	before = stripFormatChangeMarks(before)
	return PMMark{
		Type: MarkTypeSuggestedFormatChange,
		Attrs: map[string]any{
			"suggestionId": suggestionID,
			"authorId":     ch.Mark.Author,
			"ts":           float64(parseISO8601ToUnixMs(ch.Mark.Date)),
			"before":       serializeMarksToAttr(before),
			"after":        serializeMarksToAttr(afterMarks),
		},
	}
}

// stripFormatChangeMarks defensively removes any nested format-change mark from a
// before-state mark slice (a Previous rPr never carries its own rPrChange, but a
// malformed doc might).
func stripFormatChangeMarks(marks []PMMark) []PMMark {
	out := marks[:0]
	for _, m := range marks {
		if m.Type == MarkTypeSuggestedFormatChange {
			continue
		}
		out = append(out, m)
	}
	return out
}

// isAutoColor reports whether an RGBA is the "auto"/unset sentinel omnidoc
// leaves when w:color val="auto"; omnidoc only sets HasColor for real colors,
// so this is a defensive no-op guard.
func isAutoColor(c color.RGBA) bool { return c.A == 0 }

// rgbHex formats an RGBA as a 6-hex-digit RRGGBB string (no leading #).
func rgbHex(c color.RGBA) string {
	return fmt.Sprintf("%02x%02x%02x", c.R, c.G, c.B)
}

// twipsToIndentLevelInt is twipsToIndentLevel over an int (the legacy helper took
// a string off the XML attr).
func twipsToIndentLevelInt(twips int) int {
	if twips <= 0 {
		return 0
	}
	level := (twips + twipsPerIndentLevel/2) / twipsPerIndentLevel
	if level < 0 {
		return 0
	}
	if level > MaxIndentLevel {
		return MaxIndentLevel
	}
	return level
}
