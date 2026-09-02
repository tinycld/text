package translate

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/nathanstitt/omnidoc/pkg/docx"
)

// DocxToPMJSON parses .docx bytes into a ProseMirror JSON tree plus a
// list of soft-degradation warnings (for tracked changes, comments,
// content controls, unknown styles, and unknown body children).
//
// We parse word/document.xml directly via encoding/xml rather than
// going through WordZero's Document.Open because WordZero's parser
// drops content we need to preserve — most importantly, runs nested
// inside <w:hyperlink> elements never appear in Paragraph.Runs, so
// every link's text vanishes round-trip. Walking the OOXML ourselves
// also gives us full control over warnings and unrecognized elements.
//
// Hard error if: the bytes don't form a ZIP, or word/document.xml
// is missing or malformed. Everything else degrades to a Warning.
func DocxToPMJSON(ctx context.Context, docx []byte) ([]byte, []Warning, error) {
	pmJSON, warnings, _, err := docxToPMJSONShared(ctx, docx)
	return pmJSON, warnings, err
}

// DocxToPMJSONWithSuggestions is DocxToPMJSON plus the parsed
// suggestion-map entries from the customXml/tinycld-suggestions.xml
// part. The runtime bootstrap uses these to seed the Yjs `suggestions`
// Y.Map so the review drawer surfaces the existing revisions when a
// Word-edited docx is first opened in tinycld.
//
// Returns nil entries when the docx has no customXml/tinycld-suggestions.xml
// (typical for Word-authored docx — the <w:ins>/<w:del> marks still
// parse via the synthesized-id path; only the lifecycle metadata —
// status / resolvedBy / note — is absent, and the seed safely no-ops).
func DocxToPMJSONWithSuggestions(ctx context.Context, docx []byte) ([]byte, []Warning, []SuggestionMapEntry, error) {
	return docxToPMJSONShared(ctx, docx)
}

// docxToPMJSONShared is the common implementation behind DocxToPMJSON
// and DocxToPMJSONWithSuggestions. It produces the marshaled PM JSON,
// the parser warnings, and the suggestion entries; the public wrappers
// drop entries when their signature doesn't expose them.
func docxToPMJSONShared(ctx context.Context, docx []byte) ([]byte, []Warning, []SuggestionMapEntry, error) {
	root, warnings, entries, err := parseDocxToPMNode(ctx, docx)
	if err != nil {
		return nil, nil, nil, err
	}
	out, err := json.Marshal(root)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("translate: marshal root: %w", err)
	}
	return out, warnings, entries, nil
}

// parseDocxToPMNode parses .docx bytes into an in-memory PMNode tree
// plus warnings and any suggestion-map entries recovered from the
// tinycld customXml part. Shared by DocxToPMJSON /
// DocxToPMJSONWithSuggestions (which marshal to JSON for the bootstrap
// path's Y.Doc seeding) and DocxToHTML (which walks the tree directly
// to HTML for the render path).
func parseDocxToPMNode(ctx context.Context, docxBytes []byte) (PMNode, []Warning, []SuggestionMapEntry, error) {
	doc, err := docx.OpenBytes(ctx, docxBytes)
	if err != nil {
		return PMNode{}, nil, nil, fmt.Errorf("translate: open docx: %w", err)
	}

	parser := docxParser{
		docRels:   doc.Rels,
		media:     doc.Media,
		numbering: numberingFormatsFromModel(doc.Numbering),
		comments:  commentsFromModel(doc.Comments),
		footnotes: noteBodiesFromModel(doc.Footnotes),
		endnotes:  noteBodiesFromModel(doc.Endnotes),
	}
	// Load the tinycld-suggestions custom XML part if present. Failure is
	// non-fatal — Word-authored docx files won't carry it, and we still
	// need to recognize <w:ins>/<w:del> in that case by synthesizing
	// stable suggestion ids from (w:id, w:author).
	if part, ok := doc.ExtraParts["customXml/tinycld-suggestions.xml"]; ok {
		entries, mapping, perr := parseSuggestionsCustomXML(part)
		if perr == nil {
			parser.suggestionMapping = mapping
			parser.suggestionEntries = entries
		}
	}

	root := parser.walkDocument(doc)
	return root, parser.warnings, parser.suggestionEntries, nil
}

// numberingFormatsFromModel builds the numId(string) -> level-0 numFmt(string)
// map the assemble/resolve helpers read, from the parsed Numbering. Keys are
// stringified to match the legacy string-keyed map; the format string uses the
// OOXML numFmt names ("bullet"/"decimal"/…) both list-type resolvers expect.
func numberingFormatsFromModel(n *docx.Numbering) map[string]string {
	if n == nil {
		return nil
	}
	out := make(map[string]string, len(n.Instances))
	for numID := range n.Instances {
		if lvl, ok := n.Level(numID, 0); ok {
			out[strconv.Itoa(numID)] = numFmtToString(lvl.Format)
		}
	}
	return out
}

// numFmtToString maps omnidoc's NumFmt enum back to the OOXML w:numFmt val
// string the (preserved) list-type resolvers compare against.
func numFmtToString(f docx.NumFmt) string {
	switch f {
	case docx.NumFmtBullet:
		return "bullet"
	case docx.NumFmtDecimal:
		return "decimal"
	case docx.NumFmtLowerRoman:
		return "lowerRoman"
	case docx.NumFmtUpperRoman:
		return "upperRoman"
	case docx.NumFmtLowerLetter:
		return "lowerLetter"
	case docx.NumFmtUpperLetter:
		return "upperLetter"
	default:
		return "none"
	}
}

// commentsFromModel flattens the parsed comments (id -> author/date + block body)
// into the string-keyed commentInfo map the active-comment-mark path reads. The
// body blocks are flattened to plain text, matching the legacy reader.
func commentsFromModel(comments map[int]*docx.Comment) map[string]commentInfo {
	if len(comments) == 0 {
		return nil
	}
	out := make(map[string]commentInfo, len(comments))
	for id, c := range comments {
		if c == nil {
			continue
		}
		out[strconv.Itoa(id)] = commentInfo{
			Author: c.Author,
			Date:   c.Date,
			Text:   flattenBlocksText(c.Body),
		}
	}
	return out
}

// noteBodiesFromModel flattens parsed footnotes/endnotes into the string-keyed
// id -> plain-text map the reference-run path reads. Reserved separator ids
// (Word seeds -1 and 0) carry no user content and are dropped.
func noteBodiesFromModel(notes *docx.Notes) map[string]string {
	if notes == nil || len(notes.ByID) == 0 {
		return nil
	}
	out := make(map[string]string, len(notes.ByID))
	for id, blocks := range notes.ByID {
		if id <= 0 {
			continue // reserved separator / continuation-separator notes
		}
		out[strconv.Itoa(id)] = flattenBlocksText(blocks)
	}
	return out
}

// flattenBlocksText concatenates the run text of every paragraph in a block list
// (nested tables' cell text included), matching the legacy readCommentBodyText /
// parseFootnoteLikeBodies flattening.
func flattenBlocksText(blocks []docx.Block) string {
	var sb strings.Builder
	for i := range blocks {
		appendBlockText(&sb, blocks[i])
	}
	return sb.String()
}

func appendBlockText(sb *strings.Builder, blk docx.Block) {
	switch {
	case blk.Paragraph != nil:
		appendParaChildText(sb, blk.Paragraph.Content)
	case blk.Table != nil:
		for ri := range blk.Table.Rows {
			for ci := range blk.Table.Rows[ri].Cells {
				for bi := range blk.Table.Rows[ri].Cells[ci].Blocks {
					appendBlockText(sb, blk.Table.Rows[ri].Cells[ci].Blocks[bi])
				}
			}
		}
	}
}

func appendParaChildText(sb *strings.Builder, content []docx.ParaChild) {
	for i := range content {
		c := content[i]
		switch {
		case c.Run != nil:
			sb.WriteString(c.Run.Text)
		case c.Hyperlink != nil:
			for ri := range c.Hyperlink.Runs {
				sb.WriteString(c.Hyperlink.Runs[ri].Text)
			}
		case c.Revision != nil:
			appendParaChildText(sb, c.Revision.Content)
		}
	}
}

// docxParser holds the state shared across paragraph/run/table parses
// so we don't have to thread a half-dozen arguments through every call.
type docxParser struct {
	docRels      map[string]docx.Relationship // rId -> relationship (hyperlink/image targets)
	media        map[string][]byte            // part name -> media bytes (word/media/*)
	numbering    map[string]string            // numId -> "bullet" or "decimal"
	comments     map[string]commentInfo       // commentId -> author/text/date
	footnotes    map[string]string            // footnote id -> plain text body
	endnotes     map[string]string            // endnote id -> plain text body
	openComments []string                     // commentIds currently active across the cursor
	warnings     []Warning                    // accumulated soft-degradation signals
	warningSet   map[WarningCode]struct{}     // dedupe
	// suggestionMapping is the per-kind (w:id → suggestionId) map
	// recovered from the tinycld customXml part. Each docx revision
	// kind (insert/delete/formatChange) has its own w:id sequence in
	// the part, so the parser looks up the kind-specific map when
	// resolving an <w:ins>/<w:del>/<w:rPrChange> element. Empty maps
	// when the docx came from Word (or any other producer without our
	// custom part) — in that case the parser synthesizes stable ids
	// from (w:id, w:author).
	suggestionMapping suggestionMappings
	// suggestionEntries is the entry metadata from the tinycld customXml
	// part (carried for callers that want to repopulate a Yjs map).
	suggestionEntries []SuggestionMapEntry
	// activeSuggestions is the stack of currently-open suggestion marks.
	// Pushed on <w:ins>/<w:del> open, popped on the matching close.
	// flushRun applies them to every text node emitted while non-empty.
	activeSuggestions []PMMark
}

// commentInfo captures the metadata of one entry in word/comments.xml.
// Stored on the parser and stamped into MarkTypeComment marks; on export
// the same fields are written back out, so dropping or editing the
// mark cleanly removes/updates the comment in the resulting docx.
type commentInfo struct {
	Author string
	Text   string
	Date   string
}

// closeComment removes a single occurrence of id from openComments.
// Ranges close in arbitrary order (not necessarily LIFO) — a comment
// opened earlier can close after a later one — so we splice rather
// than pop.
func (p *docxParser) closeComment(id string) {
	for i, open := range p.openComments {
		if open == id {
			p.openComments = append(p.openComments[:i], p.openComments[i+1:]...)
			return
		}
	}
}

// popSuggestion drops the top entry of the active suggestion stack.
// Called on </w:ins> / </w:del>. Tolerant of empty stack — a malformed
// docx with an unbalanced close shouldn't panic the parser.
func (p *docxParser) popSuggestion() {
	if len(p.activeSuggestions) == 0 {
		return
	}
	p.activeSuggestions = p.activeSuggestions[:len(p.activeSuggestions)-1]
}

// activeSuggestionMarks returns a defensive copy of the current
// suggestion stack. flushRun appends the result to each text node's
// marks slice; mirrors activeCommentMarks.
func (p *docxParser) activeSuggestionMarks() []PMMark {
	if len(p.activeSuggestions) == 0 {
		return nil
	}
	out := make([]PMMark, len(p.activeSuggestions))
	copy(out, p.activeSuggestions)
	return out
}

// parseISO8601ToUnixMs reverses unixMsToISO8601 — converts a w:date
// (ISO-8601 / RFC 3339) string back to a unix-ms integer. Returns 0
// on empty or unparseable input so the caller emits a zero ts (and
// the round-trip stays consistent: 0 ts produces no w:date, which
// then re-parses to 0).
func parseISO8601ToUnixMs(s string) int64 {
	if s == "" {
		return 0
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return 0
	}
	return t.UnixMilli()
}

// activeCommentMarks builds one MarkTypeComment mark per currently-open
// comment id, populated with the resolved author/text/date from
// word/comments.xml. Used by flushRun to stamp the marks onto each
// text run sitting between a commentRangeStart and its matching
// commentRangeEnd.
func (p *docxParser) activeCommentMarks() []PMMark {
	if len(p.openComments) == 0 {
		return nil
	}
	out := make([]PMMark, 0, len(p.openComments))
	for _, id := range p.openComments {
		attrs := map[string]any{"id": id}
		if info, ok := p.comments[id]; ok {
			if info.Author != "" {
				attrs["author"] = info.Author
			}
			if info.Text != "" {
				attrs["text"] = info.Text
			}
			if info.Date != "" {
				attrs["date"] = info.Date
			}
		}
		out = append(out, PMMark{Type: MarkTypeComment, Attrs: attrs})
	}
	return out
}

// addWarning appends a unique warning code (we only emit one warning
// per code, no matter how many instances triggered it).
func (p *docxParser) addWarning(code WarningCode, detail string) {
	if p.warningSet == nil {
		p.warningSet = make(map[WarningCode]struct{})
	}
	if _, dup := p.warningSet[code]; dup {
		return
	}
	p.warningSet[code] = struct{}{}
	p.warnings = append(p.warnings, Warning{Code: code, Detail: detail})
}

// liftInlineImages splits a paragraph that mixes text and image runs
// into a sequence of sibling block-level nodes: one paragraph per text
// span, plus an image-only paragraph (image wrapped in its own
// <p>) between/around them.
//
// Why the image stays inside a paragraph wrapper: the PM schema
// treats image as an inline node (so floated images can sit beside
// text inside one paragraph and CSS float works). A block-level
// image at top-level would be schema-invalid; wrapping each
// "standalone" image in its own paragraph keeps the tree valid.
//
// Exception: images with wrap="left" or wrap="right" stay inline as
// the first child of the original paragraph. The emitter writes them
// with WordZero's floatLeft/floatRight position, which produces an
// <wp:anchor> inside the same <w:p> as the surrounding text — so the
// pass-3 tree is also a single paragraph containing image + text.
// Hoisting these out would break round-trip AND lose the visual
// wrapping that's the whole point of the float.
//
// Non-paragraph nodes (tables, headings) pass through unchanged.
// Empty-after-lift paragraphs are dropped.
func liftInlineImages(node PMNode) []PMNode {
	if node.Type != NodeTypeParagraph {
		return []PMNode{node}
	}
	hasLiftableImage := false
	for _, c := range node.Content {
		if c.Type == NodeTypeImage && !isFloatedImage(c) {
			hasLiftableImage = true
			break
		}
	}
	if !hasLiftableImage {
		return []PMNode{node}
	}
	var out []PMNode
	var buf []PMNode
	flush := func() {
		if len(buf) == 0 {
			return
		}
		para := PMNode{Type: NodeTypeParagraph, Content: buf, Attrs: cloneAttrs(node.Attrs)}
		out = append(out, para)
		buf = nil
	}
	for _, c := range node.Content {
		if c.Type == NodeTypeImage && !isFloatedImage(c) {
			flush()
			// Wrap the standalone image in its own paragraph; PM
			// schema requires inline image to live inside a block.
			out = append(out, PMNode{Type: NodeTypeParagraph, Content: []PMNode{c}})
			continue
		}
		buf = append(buf, c)
	}
	flush()
	return out
}

// isFloatedImage reports whether an image PM node has a wrap attr
// that anchors it inside its surrounding paragraph rather than lifting
// it to its own block. "left"/"right" floats wrap surrounding text;
// "break" (Word's "Top and Bottom") doesn't wrap, but its anchor still
// lives inside a <w:p> in the DOCX export — lifting it would force the
// emitter to invent a host paragraph and break the round-trip shape.
func isFloatedImage(node PMNode) bool {
	if node.Type != NodeTypeImage {
		return false
	}
	wrap, _ := node.Attrs["wrap"].(string)
	return wrap == "left" || wrap == "right" || wrap == "break"
}

func cloneAttrs(in map[string]any) map[string]any {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

// assembleParagraph turns the parsed pPr fields and runs into a PM
// node — heading / paragraph / blockquote, with metadata for list
// post-processing tucked into Attrs. The temporary attrs are stripped
// by groupListParagraphs.
//
// textAlign / indentLevel encode <w:jc> and <w:ind w:left> values and
// are attached to the resulting paragraph or heading node when non-
// default. List items (numID != "") and blockquote-wrapped paragraphs
// intentionally do NOT carry these — Word's <w:jc> on a list item is
// uncommon and would complicate the list round-trip; blockquote
// formatting is owned by the wrapper.
func (p *docxParser) assembleParagraph(pStyle, numID, ilvl string, textAlign string, indentLevel int, dropCapFrame bool, blockChange map[string]any, runs []PMNode) *PMNode {
	// Empty paragraph (no runs) is still a valid PM paragraph node;
	// blank lines in OOXML translate to empty PM paragraphs.
	if numID != "" {
		// List item — emit a bare paragraph carrying list metadata
		// in Attrs; groupListParagraphs will gather these and rebuild
		// the bulletList/orderedList tree.
		attrs := map[string]any{
			"_listNumId": numID,
			"_listLevel": ilvlToInt(ilvl),
			"_listFmt":   p.numbering[numID],
		}
		attachBlockChangeAttr(attrs, blockChange, NodeTypeParagraph, textAlign, indentLevel)
		return &PMNode{
			Type:    NodeTypeParagraph,
			Content: runs,
			Attrs:   attrs,
		}
	}

	// Word's document "Title"/"Subtitle" styles have no dedicated PM
	// node, so map them onto the heading hierarchy (Title→h1,
	// Subtitle→h2) rather than warning and flattening to a plain
	// paragraph — this preserves their prominence on import.
	if titleLevel := titleStyleLevel(pStyle); titleLevel != 0 {
		pStyle = fmt.Sprintf("Heading%d", titleLevel)
	}

	switch {
	case strings.HasPrefix(pStyle, "Heading"):
		level := headingLevel(pStyle)
		if level == 0 {
			// A "Heading"-prefixed style with no numeric component —
			// e.g. Word/LibreOffice's bare "Heading" or "Heading "
			// (the top-level document title style). Treat it as level 1
			// rather than warning + normalizing to the smallest heading;
			// a digitless heading is conceptually the most prominent one,
			// not the least.
			level = 1
		} else if level < 1 || level > 6 {
			p.addWarning(WarningUnsupportedStyle, fmt.Sprintf("heading level %d outside 1-6 normalized to 6", level))
			level = 6
		}
		attrs := map[string]any{"level": float64(level)}
		applyAlignIndentAttrs(attrs, textAlign, indentLevel)
		afterAttrs := map[string]any{"level": float64(level)}
		applyAlignIndentAttrs(afterAttrs, textAlign, indentLevel)
		attachBlockChangeAttrWithAfter(attrs, blockChange, NodeTypeHeading, afterAttrs)
		return &PMNode{
			Type:    NodeTypeHeading,
			Attrs:   attrs,
			Content: runs,
		}
	case pStyle == "Quote" || pStyle == "IntenseQuote":
		// Wrap a quote paragraph in a blockquote with one paragraph child.
		bq := &PMNode{
			Type: NodeTypeBlockquote,
			Content: []PMNode{
				{Type: NodeTypeParagraph, Content: runs},
			},
		}
		if blockChange != nil {
			bq.Attrs = map[string]any{}
			attachBlockChangeAttrWithAfter(bq.Attrs, blockChange, NodeTypeBlockquote, map[string]any{})
		}
		return bq
	case isCodeBlockStyle(pStyle):
		// Collapse the paragraph's runs into a single plain-text child;
		// the PM codeBlock schema doesn't carry inline marks, so any
		// bold/italic/code marks from the source are dropped (visually
		// they would not survive the monospace verbatim render anyway).
		cb := &PMNode{
			Type:    NodeTypeCodeBlock,
			Content: codeBlockChildren(runs),
		}
		if blockChange != nil {
			cb.Attrs = map[string]any{}
			attachBlockChangeAttrWithAfter(cb.Attrs, blockChange, NodeTypeCodeBlock, map[string]any{})
		}
		return cb
	case pStyle != "" && !isDefaultParagraphStyle(pStyle):
		// Unknown style — fall back to plain paragraph with a warning.
		p.addWarning(WarningUnsupportedStyle, fmt.Sprintf("paragraph style %q normalized to default paragraph", pStyle))
	}

	attrs := map[string]any{}
	applyAlignIndentAttrs(attrs, textAlign, indentLevel)
	if dropCapFrame {
		// Native Word drop cap: this paragraph is the frame holding just
		// the cap; the body follows in the next paragraph. Tag it with a
		// temporary marker that mergeDropCaps (the post-pass in
		// parseDocument) consumes — it joins this paragraph with its
		// successor into one paragraph carrying the public `dropCap`
		// attr. The marker is stripped there, so it never reaches PM JSON.
		attrs["_dropCapFrame"] = true
	}
	attachBlockChangeAttr(attrs, blockChange, NodeTypeParagraph, textAlign, indentLevel)
	if len(attrs) == 0 {
		return &PMNode{Type: NodeTypeParagraph, Content: runs}
	}
	return &PMNode{Type: NodeTypeParagraph, Attrs: attrs, Content: runs}
}

// attachBlockChangeAttr fills the suggestedBlockChange entry on a
// paragraph attrs map, deriving the AFTER state from the resolved
// (type, textAlign, indent) of the surrounding paragraph. The BEFORE
// state was already populated by parsePPrChange; this only adds the
// (suggestionId, authorId, ts, before, after) bundle to the node attrs.
//
// Skips when blockChange is nil — most paragraphs don't carry one.
func attachBlockChangeAttr(attrs map[string]any, blockChange map[string]any, blockType, textAlign string, indentLevel int) {
	if blockChange == nil {
		return
	}
	afterAttrs := map[string]any{}
	applyAlignIndentAttrs(afterAttrs, textAlign, indentLevel)
	attachBlockChangeAttrWithAfter(attrs, blockChange, blockType, afterAttrs)
}

// attachBlockChangeAttrWithAfter is the heading/blockquote-specific
// variant — they need to attach a distinct after.attrs map (level for
// headings, empty for blockquote) rather than only textAlign/indent.
func attachBlockChangeAttrWithAfter(attrs map[string]any, blockChange map[string]any, afterType string, afterAttrs map[string]any) {
	if blockChange == nil {
		return
	}
	// Fill in the after state. Before state was already populated by
	// parsePPrChange from the nested <w:pPr>.
	blockChange["after"] = map[string]any{
		"type":  afterType,
		"attrs": afterAttrs,
	}
	attrs[NodeAttrSuggestedBlockChange] = blockChange
}

// attachCellChangeAttr fills the suggestedBlockChange entry on a
// tableCell node from a parsed <w:tcPrChange>/<w:cellIns>/<w:cellDel>
// payload. The after state's shading/borders come from the outer
// cell tcPr's siblings (parseTableCellProperties already extracted
// them); for ins/del variants attachCellChangeAttr preserves the
// added/deleted flags that parseCellInsDel stamped.
//
// Skips when cellChange is nil — most cells don't carry one.
func attachCellChangeAttr(attrs map[string]any, cellChange map[string]any, shading string, borders map[string]any) {
	if cellChange == nil {
		return
	}
	// If after was already populated (parseCellInsDel for ins/del),
	// keep it. Otherwise (parseTcPrChange — attr-only), synthesize
	// from the outer tcPr siblings.
	if _, hasAfter := cellChange["after"]; !hasAfter {
		afterAttrs := map[string]any{}
		if shading != "" {
			afterAttrs["shading"] = shading
		}
		if borders != nil {
			afterAttrs["borders"] = borders
		}
		cellChange["after"] = map[string]any{
			"type":  NodeTypeTableCell,
			"attrs": afterAttrs,
		}
	}
	attrs[NodeAttrSuggestedBlockChange] = cellChange
}

// applyAlignIndentAttrs adds textAlign + indent entries to the given
// attr map when they are non-default. Defaults (textAlign="left",
// indentLevel=0) are omitted so the PM JSON stays compact for the
// 99% of paragraphs that don't carry either.
func applyAlignIndentAttrs(attrs map[string]any, textAlign string, indentLevel int) {
	if textAlign != "" && textAlign != "left" {
		attrs["textAlign"] = textAlign
	}
	if indentLevel > 0 {
		attrs["indent"] = float64(indentLevel)
	}
}

// isDefaultParagraphStyle reports whether a paragraph pStyle is a
// recognised name for "an ordinary body paragraph" — one that maps to a
// plain PM paragraph with no special handling and no fidelity loss, so
// no unsupported-style warning is warranted. Covers Word's "Normal" and
// "ListParagraph" plus the body-text style names LibreOffice and other
// exporters emit ("Body", "Body Text", "BodyText", "Default"). Matched
// case-insensitively with spaces stripped so "Body Text" / "BodyText" /
// "body text" all collapse to the same key.
//
// "DecimalAlignment" is a built-in Word style whose sole purpose is a
// decimal tab stop for numeric columns; it carries no block semantics PM
// can represent, so it collapses to a plain paragraph like the rest.
func isDefaultParagraphStyle(pStyle string) bool {
	switch strings.ToLower(strings.ReplaceAll(pStyle, " ", "")) {
	case "normal", "listparagraph", "body", "bodytext", "default", "standard", "decimalalignment":
		return true
	}
	return false
}

// titleStyleLevel maps Word's document title styles to a heading level
// (Title→1, Subtitle→2) and returns 0 for any other style. PM has no
// dedicated title node, so these collapse onto the top of the heading
// hierarchy on import. Matched case-insensitively with spaces stripped
// so "Subtitle" / "Sub Title" / "subtitle" all resolve.
func titleStyleLevel(pStyle string) int {
	switch strings.ToLower(strings.ReplaceAll(pStyle, " ", "")) {
	case "title":
		return 1
	case "subtitle":
		return 2
	}
	return 0
}

// isCodeBlockStyle returns true for the paragraph style names we
// recognise as code blocks on import. "CodeBlock" is what our own
// exporter writes; the others are common aliases produced by Word,
// pandoc, and HTML-export tooling — accepting all four lets users
// paste pre-formatted content from a wider set of source files
// without losing the monospace render.
func isCodeBlockStyle(pStyle string) bool {
	switch pStyle {
	case "CodeBlock", "Code", "HTMLPreformatted", "Preformatted":
		return true
	}
	return false
}

// codeBlockChildren flattens a paragraph's parsed runs into the
// plain-text children a PM codeBlock node accepts. Marks are dropped
// (codeBlock doesn't carry inline formatting); adjacent text nodes
// are concatenated so a multi-run paragraph collapses to one text
// child — matches Tiptap's <pre><code>…</code></pre> render where
// the entire block content is a single text node.
func codeBlockChildren(runs []PMNode) []PMNode {
	var sb strings.Builder
	for _, r := range runs {
		if r.Type == NodeTypeText {
			sb.WriteString(r.Text)
		}
	}
	if sb.Len() == 0 {
		return nil
	}
	return []PMNode{{Type: NodeTypeText, Text: sb.String()}}
}

// resolveBlockTypeFromPPr maps parsed <w:pPr> contents to a PM
// block-type / attrs pair. Mirrors the dispatch in assembleParagraph
// but without the run-content / dropCap / warning layers.
//
// Heading pStyle ("Heading1".."Heading6") → heading with level attr.
// "Quote" / "IntenseQuote" → blockquote.
// Code-block style → codeBlock.
// numPr (numID != "") → bulletList / orderedList based on numbering
// format if known; falls back to "bulletList" (PM treats unrecognized
// numbering as a bulletList).
// Otherwise → paragraph with textAlign / indent attrs.
func (p *docxParser) resolveBlockTypeFromPPr(pStyle, numID, ilvl, textAlign string, indentLevel int) (string, map[string]any) {
	_ = ilvl
	attrs := map[string]any{}
	if numID != "" {
		// A numbered/bulleted item. The BEFORE state's listItem-ness is
		// what we capture; a transition from "paragraph" → "listItem"
		// shows up as before.type=paragraph, after.type=listItem (or
		// the parent list type). We use the bulletList/orderedList
		// container type as a coarse proxy since the resolver doesn't
		// reconstruct a full PM tree from inside parsePPrChange.
		fmtKind := NodeTypeBulletList
		if format := p.numbering[numID]; format == "decimal" {
			fmtKind = NodeTypeOrderedList
		}
		applyAlignIndentAttrs(attrs, textAlign, indentLevel)
		return fmtKind, attrs
	}
	if titleLevel := titleStyleLevel(pStyle); titleLevel != 0 {
		pStyle = fmt.Sprintf("Heading%d", titleLevel)
	}
	if strings.HasPrefix(pStyle, "Heading") {
		level := headingLevel(pStyle)
		if level == 0 {
			level = 1
		}
		if level < 1 {
			level = 1
		}
		if level > 6 {
			level = 6
		}
		attrs["level"] = float64(level)
		applyAlignIndentAttrs(attrs, textAlign, indentLevel)
		return NodeTypeHeading, attrs
	}
	if pStyle == "Quote" || pStyle == "IntenseQuote" {
		return NodeTypeBlockquote, attrs
	}
	if isCodeBlockStyle(pStyle) {
		return NodeTypeCodeBlock, attrs
	}
	applyAlignIndentAttrs(attrs, textAlign, indentLevel)
	return NodeTypeParagraph, attrs
}

// normalizeJustification maps OOXML <w:jc w:val=…> values onto the PM
// textAlign enum. "both" is Word's term for full justify; anything
// outside the known set falls back to "left" (default) so unknown
// values don't propagate downstream as opaque strings.
func normalizeJustification(v string) string {
	switch v {
	case "center":
		return "center"
	case "right", "end":
		return "right"
	case "both", "distribute":
		return "justify"
	default:
		return "left"
	}
}

// twipsToIndentLevel converts a <w:ind w:left> twips string to a
// 0..MaxIndentLevel integer indent level. One level == 720 twips
// (Word's standard half-inch indent). Rounds to nearest level so a
// 1080-twip indent (3/4 inch — what Word writes for a tab stop) lands
// on level 2.
func twipsToIndentLevel(twipsStr string) int {
	twips, err := strconv.Atoi(twipsStr)
	if err != nil || twips <= 0 {
		return 0
	}
	// Round-to-nearest: +half-step before integer division.
	level := (twips + twipsPerIndentLevel/2) / twipsPerIndentLevel
	if level < 0 {
		return 0
	}
	if level > MaxIndentLevel {
		return MaxIndentLevel
	}
	return level
}

// flushRun applies the run's marks (plus any inherited extras from a
// hyperlink wrapper) to each text node in the run. Image nodes pass
// through without marks.
//
// When the run is wrapped by a <w:hyperlink>, drop the underline mark
// and clear the color attr off the textStyle mark — those are emitted
// by pm_to_docx.marksToTextFormat as visual cues on every link, so
// preserving them on import would gain marks that weren't in the
// source. fontSize / fontFamily are NOT link-derived and must survive
// (otherwise a link with an explicit font choice would lose it on
// round-trip).
func (p *docxParser) flushRun(out *[]PMNode, collected []PMNode, marks, extras []PMMark) error {
	if hasMark(extras, MarkTypeLink) {
		marks = stripMark(marks, MarkTypeUnderline)
		marks = clearTextStyleAttr(marks, "color")
	}
	combined := mergeMarks(marks, extras)
	// Comment marks are appended (not merged) because mergeMarks
	// dedupes by Type — nested ranges would otherwise collapse to one.
	combined = append(combined, p.activeCommentMarks()...)
	// Suggestion marks (insert/delete) work the same way: layered
	// suggestions on overlapping ranges produce one mark per layer,
	// and mergeMarks would collapse them to one entry by Type.
	combined = append(combined, p.activeSuggestionMarks()...)
	for _, c := range collected {
		switch c.Type {
		case NodeTypeText:
			if len(combined) > 0 {
				c.Marks = append([]PMMark(nil), combined...)
			}
		case NodeTypeFootnoteReference, NodeTypeEndnoteReference:
			// Footnote / endnote refs preserve formatting marks (so a
			// bold paragraph keeps its bold ref) but skip mark types
			// that would be visually nonsensical on a numeric ref.
		}
		*out = append(*out, c)
	}
	return nil
}

func hasMark(marks []PMMark, t string) bool {
	for _, m := range marks {
		if m.Type == t {
			return true
		}
	}
	return false
}

// clearTextStyleAttr removes a single attribute from the textStyle
// mark in marks (if present) and drops the mark entirely when it
// becomes empty. Used by flushRun to peel link-derived color cues off
// a textStyle mark that may still legitimately carry fontSize /
// fontFamily.
func clearTextStyleAttr(marks []PMMark, attr string) []PMMark {
	for i, m := range marks {
		if m.Type != MarkTypeTextStyle {
			continue
		}
		if m.Attrs == nil {
			continue
		}
		if _, ok := m.Attrs[attr]; !ok {
			continue
		}
		delete(m.Attrs, attr)
		if len(m.Attrs) == 0 {
			out := append([]PMMark{}, marks[:i]...)
			return append(out, marks[i+1:]...)
		}
		marks[i] = m
	}
	return marks
}

func stripMark(marks []PMMark, t string) []PMMark {
	out := marks[:0]
	for _, m := range marks {
		if m.Type == t {
			continue
		}
		out = append(out, m)
	}
	return out
}

// mergeMarks returns the union of two mark slices, deduplicated by
// type. The second slice (extras) wins on conflict — we use this so
// hyperlink-imposed link marks aren't shadowed by a duplicate.
func mergeMarks(a, b []PMMark) []PMMark {
	if len(a) == 0 && len(b) == 0 {
		return nil
	}
	seen := make(map[string]int, len(a)+len(b))
	out := make([]PMMark, 0, len(a)+len(b))
	for _, m := range a {
		seen[m.Type] = len(out)
		out = append(out, m)
	}
	for _, m := range b {
		if i, ok := seen[m.Type]; ok {
			out[i] = m
			continue
		}
		seen[m.Type] = len(out)
		out = append(out, m)
	}
	return out
}

// serializeMarksToAttr converts a Go-side PMMark slice to the
// SerializedMarks shape ([]map[string]any with "type" + "attrs" keys)
// the client carries on suggestedFormatChange's before/after attrs.
// Mirrors the TS-side serialize-marks helper in
// lib/suggestions/serialize-marks.ts (it produces an Array<{type, attrs}>).
func serializeMarksToAttr(marks []PMMark) []any {
	if len(marks) == 0 {
		return []any{}
	}
	out := make([]any, 0, len(marks))
	for _, m := range marks {
		entry := map[string]any{"type": m.Type}
		if len(m.Attrs) > 0 {
			entry["attrs"] = m.Attrs
		}
		out = append(out, entry)
	}
	return out
}

// emusToPixels converts an EMU (English Metric Unit) measurement into
// CSS pixels at 96 DPI. 914400 EMU = 1 inch, 96 px = 1 inch, so
// 9525 EMU = 1 px. We round to the nearest pixel because partial
// pixels never round-trip cleanly through the HTML width/height attrs
// (which are integers).
func emusToPixels(emus int) int {
	if emus <= 0 {
		return 0
	}
	return (emus + 4762) / 9525
}

// resolveWrap turns the collected anchor/wrap/position state into
// the PM image's `wrap` attribute. We only emit the attr when it's
// not the default ("none") so unwrapped images stay attribute-free
// and round-trip identically through the existing test fixtures.
//
// Mapping rules:
//   - Inline drawing (no <wp:anchor>) -> "" (no wrap attr; default
//     "none" applies).
//   - Anchor + <wp:wrapTopAndBottom> -> "break" (Word's "Top and
//     Bottom" mode; takes precedence over square/tight/through if
//     somehow both appeared in the same anchor).
//   - Anchor with no wrap*Square/Tight/Through child (and no
//     topAndBottom) -> "" (treated as none — wrapNone falls here).
//   - Anchor with wrap* present -> "left" or "right" based on
//     <wp:positionH><wp:align>. "center" falls back to "left" since
//     CSS float has no first-class "center" mode and Word renders
//     centered floats by treating them as floatLeft visually.
//     Missing align defaults to "left" (Word's default for new floats).
func resolveWrap(hasAnchor, hasWrap, hasTopAndBottom bool, posHAlign string) string {
	if !hasAnchor {
		return ""
	}
	if hasTopAndBottom {
		return "break"
	}
	if !hasWrap {
		return ""
	}
	if posHAlign == "right" {
		return "right"
	}
	return "left"
}

// wordZeroDefaultImageLabel is the literal Chinese string ("image")
// that WordZero hard-codes into wp:docPr@descr / @title whenever an
// image's ImageConfig leaves AltText / Title empty (see
// createImageParagraph in image.go in WordZero v1.6.0). When we round-
// trip an image whose alt/title were absent in the source, WordZero
// re-emits the default — the parser drops it on import to keep the
// PMNode attribute set stable across passes.
const wordZeroDefaultImageLabel = "图片"

// mimeFromExt maps a file extension (with leading dot, any case) to a
// MIME type suitable for a data: URI. Unknown extensions fall through
// to application/octet-stream — pm_to_docx.decodeImageSrc will reject
// those at emit time, which is the correct behavior since we can't
// guess the format.
func mimeFromExt(ext string) string {
	switch strings.ToLower(ext) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".bmp":
		return "image/bmp"
	case ".svg":
		return "image/svg+xml"
	default:
		return "application/octet-stream"
	}
}

// consolidateVMerges collapses OOXML vertical-merge runs into a
// single PM tableCell with rowspan>1. After parseTable finishes, every
// row carries one PM cell per <w:tc>, and continue cells carry a
// sentinel `_vmerge="continue"` attribute. This pass:
//
//  1. Walks rows top-to-bottom, tracking the most recent "start" cell
//     per physical column (a cell that began a vMerge OR a normal cell
//     that the next-row continue should attach to). A continue cell
//     directly under a start cell at the same physical column bumps
//     the start's `rowspan` and is removed from its row.
//  2. Resets the start tracker for a column when a row in that column
//     is occupied by a non-continue cell (a new vMerge run, or a fresh
//     unmerged cell — either way the previous run terminates).
//  3. Strips the `_vmerge` sentinel from every surviving cell.
//
// Physical column = position after accounting for colspan in prior
// cells of the same row. A cell with colspan=2 occupies two physical
// columns; both columns are advanced past, and a continue cell at
// either column will attach to that wide start cell.
func consolidateVMerges(tbl *PMNode) {
	if tbl == nil {
		return
	}
	type startRef struct {
		row int
		ci  int // index into tbl.Content[row].Content
	}
	// activeStart maps physical column → most-recent non-continue cell
	// covering that column. Nil entries mean "no active run here yet".
	var activeStart []*startRef

	for r := range tbl.Content {
		row := &tbl.Content[r]
		if row.Type != NodeTypeTableRow {
			continue
		}
		// Walk the row by physical column. We may splice out continue
		// cells as we go, so iterate with an index that doesn't
		// advance on splice.
		col := 0
		i := 0
		for i < len(row.Content) {
			cell := &row.Content[i]
			if cell.Type != NodeTypeTableCell {
				i++
				continue
			}
			span := cellColspanForPad(*cell)
			vm := ""
			if cell.Attrs != nil {
				if s, ok := cell.Attrs["_vmerge"].(string); ok {
					vm = s
				}
				delete(cell.Attrs, "_vmerge")
			}
			ensureCap := func(n int) {
				for len(activeStart) < n {
					activeStart = append(activeStart, nil)
				}
			}
			ensureCap(col + span)
			if vm == "continue" {
				// Attach to the active start cell at this column, if any.
				// We only consult the first spanned column — OOXML
				// permits gridSpan on a continue cell only when the
				// start cell had the same gridSpan, so all spanned
				// columns point to the same start.
				startCell := activeStart[col]
				if startCell != nil && startCell.row < r {
					sc := &tbl.Content[startCell.row].Content[startCell.ci]
					if sc.Attrs == nil {
						sc.Attrs = map[string]any{}
					}
					rs := 1
					if v, ok := sc.Attrs["rowspan"]; ok {
						if n := asIntForPad(v); n > 0 {
							rs = n
						}
					}
					sc.Attrs["rowspan"] = rs + 1
					// Remove the continue cell from this row.
					row.Content = append(row.Content[:i], row.Content[i+1:]...)
					// Don't advance i — the next cell slid into i.
					// Do advance col across the spanned columns.
					col += span
					continue
				}
				// No active start to attach to: treat as a fresh cell
				// (defensive — happens for malformed input). Fall
				// through to the start-cell branch by clearing vm.
				vm = ""
			}
			// Non-continue cell: establishes a new active run at every
			// physical column it covers.
			ref := &startRef{row: r, ci: i}
			for c := col; c < col+span; c++ {
				activeStart[c] = ref
			}
			col += span
			i++
		}
	}
}

// asIntForPad coerces an attribute value (which may have come from
// JSON as float64 or be an int) into an int. Parallel to asInt in
// pm_to_docx.go — duplicated to avoid cross-file coupling.
func asIntForPad(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case float64:
		return int(n)
	}
	return 0
}

// padTableRowsToMaxWidth normalizes a parsed table so every row spans
// the same number of physical columns, padding shorter rows with empty
// cells. The emitter (pm_to_docx.emitTable) creates a uniform-width
// WordZero table by computing max(cols) across rows; padding on import
// keeps pass-1 and pass-3 trees structurally identical.
//
// Physical-column count means: sum of colspan across cells in the row
// PLUS columns covered by an earlier row's rowspan>1 cell. A row
// holding a single cell at column 1 still has "physical width 2" if
// column 0 is being covered by a rowspan from the row above. Without
// the rowspan contribution, padding would inject a stray empty cell
// at column 1 that shifts every real cell to its right.
func padTableRowsToMaxWidth(tbl *PMNode) {
	type rowMetrics struct {
		ownCols     int // sum of colspans of cells actually in this row
		coveredCols int // cols covered by an earlier row's rowspan
	}
	// First pass: compute, for each row, how many cols are already
	// covered by earlier rows' rowspan=N cells.
	covered := make([]int, len(tbl.Content))
	// activeRowspans tracks remaining rowspan rows for each "logical"
	// column position, but rowspans are anchored at physical column
	// indices — and physical columns shift if we don't carefully
	// account for ordering. Use a slice indexed by physical col.
	var rowspanAt []int // remaining rows of cover at each physical col
	metrics := make([]rowMetrics, len(tbl.Content))
	for r, row := range tbl.Content {
		if row.Type != NodeTypeTableRow {
			continue
		}
		col := 0
		own := 0
		cov := 0
		// Track which physical-col cover entries are "new this row"
		// so we don't decrement them at end-of-row (they apply to
		// subsequent rows only).
		newThisRow := make(map[int]bool)
		for _, cell := range row.Content {
			if cell.Type != NodeTypeTableCell {
				continue
			}
			for col < len(rowspanAt) && rowspanAt[col] > 0 {
				col++
				cov++
			}
			span := cellColspanForPad(cell)
			rspan := cellRowspanForPad(cell)
			for len(rowspanAt) < col+span {
				rowspanAt = append(rowspanAt, 0)
			}
			if rspan > 1 {
				for c := col; c < col+span; c++ {
					rowspanAt[c] = rspan - 1
					newThisRow[c] = true
				}
			}
			own += span
			col += span
		}
		// Cover past the end of this row's own cells still counts.
		for c := col; c < len(rowspanAt); c++ {
			if rowspanAt[c] > 0 {
				cov++
			}
		}
		metrics[r] = rowMetrics{ownCols: own, coveredCols: cov}
		covered[r] = cov
		// Decrement at end-of-row — but skip entries we just set, so
		// the next row still sees them as covered.
		for c := range rowspanAt {
			if newThisRow[c] {
				continue
			}
			if rowspanAt[c] > 0 {
				rowspanAt[c]--
			}
		}
	}
	maxCols := 0
	for _, m := range metrics {
		if total := m.ownCols + m.coveredCols; total > maxCols {
			maxCols = total
		}
	}
	for i := range tbl.Content {
		row := &tbl.Content[i]
		if row.Type != NodeTypeTableRow {
			continue
		}
		want := maxCols - metrics[i].coveredCols
		for metrics[i].ownCols < want {
			row.Content = append(row.Content, PMNode{
				Type: NodeTypeTableCell,
				Content: []PMNode{
					{Type: NodeTypeParagraph},
				},
			})
			metrics[i].ownCols++
		}
	}
}

// cellColspanForPad reads colspan off a tableCell, defaulting to 1.
// Parallel to cellColspan in pm_to_docx.go — kept separate so docx_to_pm
// doesn't depend on the export side of the package.
func cellColspanForPad(cell PMNode) int {
	if cell.Attrs == nil {
		return 1
	}
	if v, ok := cell.Attrs["colspan"]; ok {
		switch n := v.(type) {
		case int:
			if n > 0 {
				return n
			}
		case float64:
			if n > 0 {
				return int(n)
			}
		}
	}
	return 1
}

// cellRowspanForPad reads rowspan off a tableCell, defaulting to 1.
// Parallel to cellColspanForPad. Driven by the same attribute the
// editor's TableCell extension exposes ("rowspan", set by Tiptap's
// columnResizing/mergeCells flow and by consolidateVMerges on import).
func cellRowspanForPad(cell PMNode) int {
	if cell.Attrs == nil {
		return 1
	}
	if v, ok := cell.Attrs["rowspan"]; ok {
		switch n := v.(type) {
		case int:
			if n > 0 {
				return n
			}
		case float64:
			if n > 0 {
				return int(n)
			}
		}
	}
	return 1
}

// applyTableCellWidth converts a cell's dxa width into TipTap's
// `colwidth` attribute (array of px widths, one per spanned column)
// and stamps it on the cell along with `colspan` if it spans columns.
// Skips when dxa is 0 (no explicit width — auto-sized).
//
// When the table's <w:tblGrid> per-column widths are available AND
// they align with the cell (colIdx + gridSpan ≤ len(gridCols)), each
// spanned column's px width is taken straight from the grid. This is
// what avoids round-trip drift: re-importing an emitted table sees
// the same per-column widths instead of evenly-split derived ones.
//
// Falls back to evenly splitting <w:tcW> across spanned columns when
// the grid is missing or misaligned (e.g. malformed source).
func applyTableCellWidth(cell *PMNode, tcWDxa, gridSpan int, gridCols []int, colIdx int) {
	if gridSpan > 1 {
		if cell.Attrs == nil {
			cell.Attrs = map[string]any{}
		}
		cell.Attrs["colspan"] = gridSpan
	}
	// Prefer <w:tblGrid> per-column widths — they are the canonical
	// source of column layout in OOXML and round-trip cleanly.
	if colIdx+gridSpan <= len(gridCols) {
		widths := make([]int, gridSpan)
		for i := 0; i < gridSpan; i++ {
			widths[i] = dxaToPx(gridCols[colIdx+i])
		}
		if cell.Attrs == nil {
			cell.Attrs = map[string]any{}
		}
		cell.Attrs["colwidth"] = widths
		return
	}
	if tcWDxa <= 0 {
		return
	}
	totalPx := dxaToPx(tcWDxa)
	if totalPx <= 0 {
		return
	}
	widths := make([]int, gridSpan)
	base := totalPx / gridSpan
	rem := totalPx - base*gridSpan
	for i := range widths {
		widths[i] = base
		if i < rem {
			widths[i]++
		}
	}
	if cell.Attrs == nil {
		cell.Attrs = map[string]any{}
	}
	cell.Attrs["colwidth"] = widths
}

func dxaToPx(dxa int) int {
	if dxa <= 0 {
		return 0
	}
	// Integer division matches Word's perceived sizing closely enough
	// for the editor (we don't need sub-pixel accuracy on screen).
	return dxa / 15
}

// collapseLeadingEmptyParagraphs normalizes the placeholder paragraphs
// WordZero leaves behind in cells. WordZero's AddCellParagraph does
// not replace the empty placeholder it seeds into each new cell, so
// every emitted cell ends up with a leading empty paragraph plus the
// appended one. Stripping it on import keeps the round-trip stable;
// visually a leading empty paragraph in a cell is rarely intentional.
//
// Two normalizations:
//
//   - If the cell mixes empty leading paragraphs with at least one
//     non-empty sibling, drop the leading empties.
//   - If the cell is entirely empty paragraphs, collapse to a single
//     empty paragraph (PM tableCell requires at least one paragraph).
func collapseLeadingEmptyParagraphs(content []PMNode) []PMNode {
	idx := 0
	for idx < len(content) && isEmptyParagraph(content[idx]) {
		idx++
	}
	if idx == len(content) && idx > 1 {
		// Entirely-empty cell: collapse to a single empty paragraph.
		return content[:1]
	}
	if idx == 0 || idx == len(content) {
		return content
	}
	return content[idx:]
}

func isEmptyParagraph(n PMNode) bool {
	return n.Type == NodeTypeParagraph && len(n.Content) == 0 && len(n.Attrs) == 0
}

// highlightNameToHex maps OOXML's <w:highlight w:val="…"> fixed-palette
// names to hex strings the renderer can consume uniformly with w:shd's
// arbitrary hex fill. Word's highlighter only supports this fixed set
// (see ST_HighlightColor in the OOXML spec); arbitrary backgrounds go
// through w:shd instead. Unknown names (including "none") return ""
// and the caller drops the attr.
func highlightNameToHex(name string) string {
	switch strings.ToLower(name) {
	case "black":
		return "#000000"
	case "blue":
		return "#0000FF"
	case "cyan":
		return "#00FFFF"
	case "darkblue":
		return "#000080"
	case "darkcyan":
		return "#008080"
	case "darkgray":
		return "#808080"
	case "darkgreen":
		return "#008000"
	case "darkmagenta":
		return "#800080"
	case "darkred":
		return "#800000"
	case "darkyellow":
		return "#808000"
	case "green":
		return "#00FF00"
	case "lightgray":
		return "#C0C0C0"
	case "magenta":
		return "#FF00FF"
	case "red":
		return "#FF0000"
	case "white":
		return "#FFFFFF"
	case "yellow":
		return "#FFFF00"
	}
	return ""
}

// headingLevel pulls an int out of "HeadingN" / "headingN" /
// "heading N". Returns 0 if no digit is present.
func headingLevel(style string) int {
	for i := len(style) - 1; i >= 0; i-- {
		if style[i] >= '0' && style[i] <= '9' {
			n, err := strconv.Atoi(string(style[i]))
			if err == nil {
				return n
			}
		}
	}
	return 0
}

// ilvlToInt converts a w:val string ("0", "1", …) to int, defaulting
// to 0 on parse failure.
func ilvlToInt(s string) int {
	if s == "" {
		return 0
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0
	}
	return n
}

// groupListParagraphs is the post-pass that turns the flat OOXML
// list-paragraph stream into PM's nested bulletList / orderedList /
// listItem trees. It walks block-level children left-to-right; runs
// of paragraphs sharing the same numId are bundled into one list
// node, and ilvl is honored to nest sub-lists inside their parent
// listItem.
//
// Numbering continuation: in OOXML, a numbered list can be visually
// interrupted (e.g. by a nested bulleted list with a different numId)
// and then resume with the same numId. Word renders the resumption
// continuing the previous numbering (1..5, bullets, 6.). We honor
// this by tracking the running level-0 item count per ordered numId
// and emitting `start` on each resumed list so it picks up where the
// previous one left off.
func groupListParagraphs(blocks []PMNode) []PMNode {
	var out []PMNode
	// Level-0 items emitted so far for each ordered-list numId. Only
	// level-0 items contribute to the visible number on the resumed
	// list; nested items reset their own counter inside the sub-list.
	emitted := map[string]int{}
	i := 0
	for i < len(blocks) {
		if numID, ok := listNumID(blocks[i]); ok {
			run := []PMNode{}
			for i < len(blocks) {
				id, ok := listNumID(blocks[i])
				if !ok || id != numID {
					break
				}
				run = append(run, blocks[i])
				i++
			}
			startAt := 0
			if listTypeFromFmt(listFmt(run[0])) == NodeTypeOrderedList {
				startAt = emitted[numID]
			}
			tree := buildListTree(run)
			if startAt > 0 && tree.Type == NodeTypeOrderedList {
				if tree.Attrs == nil {
					tree.Attrs = map[string]any{}
				}
				tree.Attrs["start"] = startAt + 1
			}
			for _, para := range run {
				if paraLevel(para) == 0 {
					emitted[numID]++
				}
			}
			out = append(out, tree)
			continue
		}
		out = append(out, blocks[i])
		i++
	}
	return out
}

// renestInterruptingBulletSubLists fixes a docx-shape problem: Word
// often emits a nested bullet list (under one item of a numbered
// outline) as a separate list paragraph stream with its own numId,
// so groupListParagraphs ends up producing three sibling list nodes:
//
//	orderedList (items 1..N, numId=A)
//	bulletList  (the sub-bullets,  numId=B)
//	orderedList (items N+1.., numId=A, start=N+1)
//
// The user's mental model is one outline with sub-bullets nested
// inside item N. Reading order is preserved either way, but the
// rendered HTML looks broken — the bullets appear at top level
// rather than indented under their parent.
//
// This pass walks the block list and, whenever it finds the pattern
// above, moves the bulletList inside the last listItem of the first
// orderedList AND merges the two halves of the orderedList into one
// (dropping the `start` attribute on the second half, since the
// numbering now flows naturally without resumption).
//
// We only merge when the two orderedList halves share the same numId
// (verifiable indirectly: the second half's `start` attribute equals
// the first half's item count + 1). Sibling ordered lists that don't
// belong together — e.g. two unrelated outlines — leave the
// interrupting bulletList where it was.
func renestInterruptingBulletSubLists(blocks []PMNode) []PMNode {
	out := make([]PMNode, 0, len(blocks))
	i := 0
	for i < len(blocks) {
		if i+2 < len(blocks) &&
			blocks[i].Type == NodeTypeOrderedList &&
			blocks[i+1].Type == NodeTypeBulletList &&
			blocks[i+2].Type == NodeTypeOrderedList {
			firstOL, midUL, secondOL := blocks[i], blocks[i+1], blocks[i+2]
			expectedStart := topLevelItemCount(firstOL) + 1
			if secondStart, _ := secondOL.Attrs["start"].(int); secondStart == expectedStart {
				merged := mergeOrderedListsAroundBulletInterrupt(firstOL, midUL, secondOL)
				out = append(out, merged)
				i += 3
				continue
			}
		}
		out = append(out, blocks[i])
		i++
	}
	return out
}

// topLevelItemCount counts immediate listItem children of a list node.
// Nested sub-lists don't contribute to the outer list's item count.
func topLevelItemCount(list PMNode) int {
	n := 0
	for _, c := range list.Content {
		if c.Type == NodeTypeListItem {
			n++
		}
	}
	return n
}

// mergeOrderedListsAroundBulletInterrupt rebuilds the first orderedList
// so its last listItem contains the bulletList as a child block, then
// appends every listItem from the second orderedList. The `start`
// attribute on the second half is no longer needed (numbering flows
// continuously through one list now) so it's dropped.
func mergeOrderedListsAroundBulletInterrupt(firstOL, midUL, secondOL PMNode) PMNode {
	merged := PMNode{Type: NodeTypeOrderedList, Content: make([]PMNode, 0, len(firstOL.Content)+len(secondOL.Content))}
	if firstOL.Attrs != nil {
		merged.Attrs = cloneAttrs(firstOL.Attrs)
	}
	merged.Content = append(merged.Content, firstOL.Content...)
	if last := len(merged.Content) - 1; last >= 0 && merged.Content[last].Type == NodeTypeListItem {
		item := merged.Content[last]
		item.Content = append(item.Content, midUL)
		merged.Content[last] = item
	}
	for _, c := range secondOL.Content {
		if c.Type == NodeTypeListItem {
			merged.Content = append(merged.Content, c)
		}
	}
	return merged
}

func listNumID(node PMNode) (string, bool) {
	if node.Type != NodeTypeParagraph {
		return "", false
	}
	v, ok := node.Attrs["_listNumId"].(string)
	return v, ok && v != ""
}

// buildListTree turns a sequence of paragraphs — all sharing one
// numId — into a single nested list node. ilvl drives nesting depth.
//
// The paragraphs come in document order. Whenever the level rises
// (e.g. ilvl 0 -> 1) we open a nested list inside the most recently
// opened listItem; whenever it drops, we close back to the matching
// depth.
func buildListTree(paras []PMNode) PMNode {
	if len(paras) == 0 {
		return PMNode{}
	}
	// Word's docx can emit a same-numId paragraph stream that never
	// reaches ilvl=0 (e.g. a sub-bullet list with its own numId whose
	// only paragraphs are all at ilvl=1, because the emitter wrote
	// them nested inside an outer ordered listItem). buildListTree's
	// frame stack expects the root to be ilvl=0, so a deeper-only
	// stream would trigger the "synthesize empty placeholder" branch
	// once per missing level. Normalize the stream so the shallowest
	// observed level is 0 — the relative nesting is what matters, not
	// the absolute level number.
	minLvl := -1
	for _, p := range paras {
		l := paraLevel(p)
		if minLvl < 0 || l < minLvl {
			minLvl = l
		}
	}
	if minLvl > 0 {
		paras = append([]PMNode(nil), paras...)
		for i := range paras {
			cur := paraLevel(paras[i])
			if paras[i].Attrs == nil {
				paras[i].Attrs = map[string]any{}
			} else {
				paras[i].Attrs = cloneAttrs(paras[i].Attrs)
			}
			paras[i].Attrs["_listLevel"] = cur - minLvl
		}
	}
	rootType := listTypeFromFmt(listFmt(paras[0]))
	root := PMNode{Type: rootType}

	// Stack of (listNode, currentItem) frames; index 0 is the root list.
	type frame struct {
		list *PMNode
		item *PMNode
		lvl  int
	}
	stack := []frame{{list: &root, lvl: 0}}

	for _, para := range paras {
		lvl := paraLevel(para)
		// Pop frames whose level is deeper than this paragraph's level.
		for len(stack) > 1 && stack[len(stack)-1].lvl > lvl {
			stack = stack[:len(stack)-1]
		}
		// If we're going deeper, push a new sub-list under the
		// current top frame's most recent item.
		for stack[len(stack)-1].lvl < lvl {
			parent := stack[len(stack)-1]
			if parent.item == nil {
				// Edge case: list starts at level >0 with no level-0
				// item — synthesize an empty placeholder item so the
				// nesting has a parent.
				newItem := PMNode{Type: NodeTypeListItem, Content: []PMNode{
					{Type: NodeTypeParagraph},
				}}
				parent.list.Content = append(parent.list.Content, newItem)
				parent.item = &parent.list.Content[len(parent.list.Content)-1]
				stack[len(stack)-1] = parent
			}
			subList := PMNode{Type: listTypeFromFmt(listFmt(para))}
			parent.item.Content = append(parent.item.Content, subList)
			subPtr := &parent.item.Content[len(parent.item.Content)-1]
			stack = append(stack, frame{list: subPtr, lvl: parent.lvl + 1})
		}
		// Now stack top is the right list — append a new item.
		top := &stack[len(stack)-1]
		stripped := stripListAttrs(para)
		newItem := PMNode{
			Type:    NodeTypeListItem,
			Content: []PMNode{stripped},
		}
		top.list.Content = append(top.list.Content, newItem)
		top.item = &top.list.Content[len(top.list.Content)-1]
	}
	return root
}

func paraLevel(node PMNode) int {
	if v, ok := node.Attrs["_listLevel"].(int); ok {
		return v
	}
	return 0
}

func listFmt(node PMNode) string {
	if v, ok := node.Attrs["_listFmt"].(string); ok {
		return v
	}
	return ""
}

// listTypeFromFmt maps an OOXML numFmt value onto the PM list-type.
// Only "bullet" maps to bulletList; everything else (decimal,
// lowerLetter, lowerRoman, upperLetter, upperRoman, …) is treated as
// orderedList — ProseMirror's schema only has the binary distinction.
func listTypeFromFmt(fmt string) string {
	if fmt == "bullet" {
		return NodeTypeBulletList
	}
	return NodeTypeOrderedList
}

// stripListAttrs returns a copy of the paragraph with the temporary
// list-tracking attrs removed.
func stripListAttrs(node PMNode) PMNode {
	if node.Attrs == nil {
		return node
	}
	clean := PMNode{
		Type:    node.Type,
		Content: node.Content,
		Text:    node.Text,
		Marks:   node.Marks,
	}
	for k, v := range node.Attrs {
		if k == "_listNumId" || k == "_listLevel" || k == "_listFmt" {
			continue
		}
		if clean.Attrs == nil {
			clean.Attrs = map[string]any{}
		}
		clean.Attrs[k] = v
	}
	return clean
}
