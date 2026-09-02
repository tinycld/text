package translate

// This file builds a omnidoc *docx.Document directly from a ProseMirror
// JSON tree and serializes it with docx.Bytes. The writer (pkg/docx) owns all
// OPC packaging — relationships, content types, media parts, numbering,
// footnotes/endnotes, comments — so there is no post-process / marker-token
// layer here anymore: every feature maps onto a first-class model field.

import (
	"context"
	"encoding/json"
	"fmt"
	"image/color"
	"strings"
	"unicode/utf8"

	"github.com/nathanstitt/omnidoc/pkg/docx"
)

// MaxImageBytes caps a single embedded image at 4 MiB. Larger images
// are dropped with WarningImageTooLarge rather than embedded — the
// limit bounds the memory cost of round-tripping a docx that contains
// a hostile or accidentally enormous data: URI from the client.
const MaxImageBytes = 4 * 1024 * 1024

// allowedImageMediaTypes is the whitelist of data: URI media types the
// emitter embeds. Anything outside (image/svg+xml, image/bmp, …) is
// dropped with WarningUnsupportedImageType — Word rejects unknown image
// parts and SVG specifically would require rasterization we don't
// perform.
var allowedImageMediaTypes = map[string]bool{
	"image/png":  true,
	"image/jpeg": true,
	"image/jpg":  true,
	"image/gif":  true,
	"image/webp": true,
}

// linkAccentColor is the accent blue Word renders hyperlinks in. A link
// mark forces this color + underline on its runs (fontSize/fontFamily
// still apply).
var linkAccentColor = color.RGBA{R: 0x05, G: 0x63, B: 0xC1, A: 0xFF}

// PMJSONToDocx translates a ProseMirror JSON tree into .docx bytes.
// Returns an error if the JSON is malformed or contains node/mark
// types outside the supported set.
//
// Soft degradations (e.g. an oversized image dropped) are silently
// discarded by this wrapper. Callers that want to surface them to the
// user should use PMJSONToDocxWithWarnings instead.
func PMJSONToDocx(ctx context.Context, pmJSON []byte) ([]byte, error) {
	bs, _, err := PMJSONToDocxWithWarnings(ctx, pmJSON)
	return bs, err
}

// PMJSONToDocxWithResolver is the variant the server flush uses: it
// supplies an ImageResolver so inserted drive-file images (stored as
// /api/files/drive_items/<id>/<file> URLs, not data: URIs) can be
// fetched and embedded. A nil resolver behaves exactly like
// PMJSONToDocx — drive URLs are rejected.
func PMJSONToDocxWithResolver(ctx context.Context, pmJSON []byte, resolver ImageResolver) ([]byte, []Warning, error) {
	return pmJSONToDocx(ctx, pmJSON, resolver, nil)
}

// PMJSONToDocxWithWarnings is the warnings-aware variant of
// PMJSONToDocx. The returned slice contains every soft-degradation
// signal the emitter raised (e.g. an oversized image was dropped) —
// hard errors still come back via the error return.
func PMJSONToDocxWithWarnings(ctx context.Context, pmJSON []byte) ([]byte, []Warning, error) {
	return pmJSONToDocx(ctx, pmJSON, nil, nil)
}

// PMJSONToDocxWithSuggestions is PMJSONToDocxWithWarnings plus the
// suggestion-map entries that the runtime read from the Yjs
// 'suggestions' Y.Map. The entries carry the status / resolvedBy / note
// metadata we want to round-trip — Word reads the <w:ins>/<w:del>
// revisions we emit alongside; tinycld readers pick up the
// customXml/tinycld-suggestions.xml part for the full picture.
//
// Pass nil for entries when the caller has no suggestion metadata to
// round-trip — the emitter will still produce the (w:id → suggestionId)
// mapping from whatever spans the walk encounters, just without the
// status/resolvedBy/note metadata.
func PMJSONToDocxWithSuggestions(ctx context.Context, pmJSON []byte, entries []SuggestionMapEntry) ([]byte, []Warning, error) {
	return pmJSONToDocx(ctx, pmJSON, nil, entries)
}

// PMJSONToDocxWithResolverAndSuggestions combines the resolver and
// suggestion-entries variants. The server flush uses this entry point:
// it has both a drive-backed ImageResolver and the runtime-read
// suggestion entries to thread through.
func PMJSONToDocxWithResolverAndSuggestions(
	ctx context.Context,
	pmJSON []byte,
	resolver ImageResolver,
	entries []SuggestionMapEntry,
) ([]byte, []Warning, error) {
	return pmJSONToDocx(ctx, pmJSON, resolver, entries)
}

func pmJSONToDocx(ctx context.Context, pmJSON []byte, resolver ImageResolver, entries []SuggestionMapEntry) ([]byte, []Warning, error) {
	var root PMNode
	if err := json.Unmarshal(pmJSON, &root); err != nil {
		return nil, nil, fmt.Errorf("translate: unmarshal pmJSON: %w", err)
	}
	if root.Type != NodeTypeDoc {
		return nil, nil, fmt.Errorf("translate: pmJSON root must be type=doc, got %q", root.Type)
	}

	b := newBuilder()
	b.imageResolver = resolver
	b.suggestionEntries = entries
	for _, child := range root.Content {
		if err := b.emitBlock(&b.doc.Body, child, 0, ""); err != nil {
			return nil, nil, err
		}
	}
	b.attachSuggestionsPart()

	bs, err := docx.Bytes(ctx, b.doc)
	if err != nil {
		return nil, nil, fmt.Errorf("translate: serialize docx: %w", err)
	}
	return bs, b.warnings, nil
}

// ImageResolver returns the raw bytes for an inserted drive-file image,
// identified by the drive_items record id and the stored file name parsed
// out of an /api/files/drive_items/<id>/<file> src. Returning an error
// aborts the flush (the image can't be embedded, so the docx would be
// lossy); the server's SaveCoordinator retries.
type ImageResolver func(driveItemID, fileName string) ([]byte, error)

// builder walks a PM tree into a docx.Document. It carries the cross-call
// state the model needs: list-numbering allocation, the revision/comment id
// counters, and the collected suggestion spans that feed the customXml part.
type builder struct {
	doc *docx.Document

	// List numbering. listScope tracks the NumID to reuse for the current
	// bulletList / orderedList (and its nested children), one entry per
	// nested depth; cleared on exit. Reusing a NumID across the items of one
	// logical PM list is what lets the importer regroup them.
	listScope []int
	// lastOrderedNumIDAtLevel0 is the most recent level-0 ordered-list NumID,
	// surviving across sibling lists. A resumed ordered list (start>1) reuses
	// it so the importer's document-order continuation heuristic renumbers.
	lastOrderedNumIDAtLevel0 int
	nextNumID                int // monotonic w:numId allocator (1-based)
	bulletAbstractID         int // abstract id for the shared bullet definition (-1 = unallocated)
	orderedAbstractID        int // abstract id for the shared decimal definition (-1 = unallocated)
	nextAbstractID           int

	// Revision / comment / note id allocators. Each docx element kind has its
	// own independent w:id sequence (Word treats them as separate counters),
	// mirroring the pre-migration emitter.
	insertDeleteSeq int
	formatChangeSeq int
	blockChangeSeq  int
	cellChangeSeq   int
	commentSeq      int // OOXML comment id allocator for synthesized ids
	footnoteSeq     int
	endnoteSeq      int

	// commentIDByPMID maps a PM comment mark's id string to the int docx
	// comment id we allocated, so a comment whose range spans multiple runs
	// points at one word/comments.xml entry.
	commentIDByPMID map[string]int

	// Suggestion spans collected during the walk, feeding both the customXml
	// (w:id → suggestionId) mapping and the entries part.
	suggestionSpans   []suggestionSpan
	formatChangeSpans []formatChangeSpan
	blockChangeSpans  []blockChangeSpan
	cellChangeSpans   []cellChangeSpan
	suggestionEntries []SuggestionMapEntry

	warnings   []Warning
	warningSet map[WarningCode]struct{}

	imageResolver ImageResolver
}

func newBuilder() *builder {
	return &builder{
		doc: &docx.Document{
			Styles:    docx.DefaultStyles(),
			Numbering: docx.NewNumbering(),
		},
		nextNumID:         1,
		nextAbstractID:    0,
		bulletAbstractID:  -1,
		orderedAbstractID: -1,
		commentIDByPMID:   map[string]int{},
	}
}

// addWarning records a unique soft-degradation signal (one entry per code).
func (b *builder) addWarning(code WarningCode, detail string) {
	if b.warningSet == nil {
		b.warningSet = make(map[WarningCode]struct{})
	}
	if _, seen := b.warningSet[code]; seen {
		return
	}
	b.warningSet[code] = struct{}{}
	b.warnings = append(b.warnings, Warning{Code: code, Detail: detail})
}

// attachSuggestionsPart writes the customXml/tinycld-suggestions.xml part when
// the walk collected any suggestion spans or the caller supplied entries.
func (b *builder) attachSuggestionsPart() {
	if len(b.suggestionSpans) == 0 && len(b.formatChangeSpans) == 0 &&
		len(b.blockChangeSpans) == 0 && len(b.cellChangeSpans) == 0 &&
		len(b.suggestionEntries) == 0 {
		return
	}
	data, err := writeSuggestionsCustomXML(
		b.suggestionSpans, b.formatChangeSpans, b.blockChangeSpans, b.cellChangeSpans,
		b.suggestionEntries)
	if err != nil {
		// Serialization of a small XML tree we control shouldn't fail; if it
		// somehow does, skip the part rather than abort the whole flush.
		return
	}
	if b.doc.ExtraParts == nil {
		b.doc.ExtraParts = map[string][]byte{}
	}
	b.doc.ExtraParts["customXml/tinycld-suggestions.xml"] = data
}

// emitBlock dispatches on a block-level PMNode type, appending to out.
// listLevel/parentList are set when recursing inside a list item.
func (b *builder) emitBlock(out *[]docx.Block, node PMNode, listLevel int, parentList string) error {
	switch node.Type {
	case NodeTypeParagraph:
		return b.emitParagraph(out, node, listLevel, parentList)
	case NodeTypeHeading:
		return b.emitHeading(out, node)
	case NodeTypeBulletList:
		return b.emitList(out, node, listLevel, NodeTypeBulletList)
	case NodeTypeOrderedList:
		return b.emitList(out, node, listLevel, NodeTypeOrderedList)
	case NodeTypeBlockquote:
		return b.emitBlockquote(out, node)
	case NodeTypeCodeBlock:
		return b.emitCodeBlock(out, node)
	case NodeTypeTable:
		return b.emitTable(out, node)
	case NodeTypeImage:
		return b.emitImageBlock(out, node)
	default:
		return fmt.Errorf("translate: unsupported block node type %q", node.Type)
	}
}

// emitParagraph emits a normal paragraph, a list-item paragraph, or a
// two-paragraph drop cap.
func (b *builder) emitParagraph(out *[]docx.Block, node PMNode, listLevel int, parentList string) error {
	if parentList != "" {
		return b.emitListParagraph(out, node, listLevel, parentList)
	}
	if boolAttr(node.Attrs, "dropCap") {
		if done, err := b.emitDropCapParagraph(out, node); done || err != nil {
			return err
		}
		// Fell through: dropCap attr but no leading text to cap (e.g. starts
		// with an image). Emit as a normal paragraph.
	}
	props := b.paragraphProps(node.Attrs, "")
	content, err := b.inlineContent(node.Content)
	if err != nil {
		return err
	}
	*out = append(*out, docx.Block{Paragraph: &docx.Paragraph{Props: props, Content: content}})
	return nil
}

// paragraphProps builds a docx.ParagraphProps from a PM node's attrs: the
// paragraph style (heading/quote/code/listParagraph via pStyle), alignment,
// left indent, and any suggestedBlockChange (as a PPrChange).
func (b *builder) paragraphProps(attrs map[string]any, pStyle string) docx.ParagraphProps {
	props := docx.ParagraphProps{StyleID: pStyle}
	if v, ok := attrs["textAlign"].(string); ok {
		if jc, has := pmAlignToJustify(v); has {
			props.Justify, props.HasJustify = jc, true
		}
	}
	if level := indentLevelFromAttrs(attrs); level > 0 {
		props.IndentLeft = docx.Twips(level * twipsPerIndentLevel)
		props.HasIndentLeft = true
	}
	if change := b.blockChangeFromAttrs(attrs); change != nil {
		props.PPrChange = change
	}
	return props
}

// blockChangeFromAttrs builds a ParaPropsChange from a suggestedBlockChange
// attr (paragraph/heading/blockquote/codeBlock). Returns nil when absent. The
// Previous state is the before-shape's paragraph props; the outer props already
// carry the after shape.
func (b *builder) blockChangeFromAttrs(attrs map[string]any) *docx.ParaPropsChange {
	span := b.queueBlockChangeAttrs(attrs)
	if span == nil {
		return nil
	}
	prev := blockStateToParagraphProps(span.BeforeType, span.BeforeAttrs)
	return &docx.ParaPropsChange{
		Mark:     docx.RevisionMark{ID: span.DocxRevisionID, Author: span.AuthorID, Date: unixMsToISO8601(span.Ts)},
		Previous: prev,
	}
}

// emitDropCapParagraph splits a PM dropCap paragraph into Word's native
// two-paragraph form: a cap paragraph (the first character) carrying a drop-cap
// frame, then a body paragraph with the remainder + the align/indent attrs.
// Returns (true, nil) when it emitted the split form; (false, nil) when there
// is no leading text character to use as a cap.
func (b *builder) emitDropCapParagraph(out *[]docx.Block, node PMNode) (bool, error) {
	capRun, restRuns, ok := splitFirstChar(node.Content)
	if !ok {
		return false, nil
	}

	capContent, err := b.inlineContent([]PMNode{capRun})
	if err != nil {
		return false, err
	}
	capProps := docx.ParagraphProps{Frame: &docx.FramePr{DropCap: "drop", Lines: 3}}
	*out = append(*out, docx.Block{Paragraph: &docx.Paragraph{Props: capProps, Content: capContent}})

	bodyProps := b.paragraphProps(node.Attrs, "")
	bodyContent, err := b.inlineContent(restRuns)
	if err != nil {
		return false, err
	}
	*out = append(*out, docx.Block{Paragraph: &docx.Paragraph{Props: bodyProps, Content: bodyContent}})
	return true, nil
}

// splitFirstChar splits a paragraph's inline content so the first character of
// the first text run becomes a standalone cap run (keeping that run's marks),
// and everything after it is the remainder. Leading empty text runs are
// skipped. Returns ok=false when no leading text character exists.
func splitFirstChar(content []PMNode) (capRun PMNode, rest []PMNode, ok bool) {
	for i, n := range content {
		if n.Type != NodeTypeText {
			return PMNode{}, nil, false
		}
		if n.Text == "" {
			continue
		}
		r, size := utf8.DecodeRuneInString(n.Text)
		if r == utf8.RuneError && size <= 1 {
			continue
		}
		cap := PMNode{Type: NodeTypeText, Text: n.Text[:size], Marks: n.Marks}
		rest = make([]PMNode, 0, len(content)-i)
		if remainder := n.Text[size:]; remainder != "" {
			rest = append(rest, PMNode{Type: NodeTypeText, Text: remainder, Marks: n.Marks})
		}
		rest = append(rest, content[i+1:]...)
		return cap, rest, true
	}
	return PMNode{}, nil, false
}

// pmAlignToJustify maps a PM textAlign value to a docx.Justify. Left is the
// default and returns has=false so the attribute is omitted.
func pmAlignToJustify(v string) (docx.Justify, bool) {
	switch v {
	case "center":
		return docx.JustifyCenter, true
	case "right":
		return docx.JustifyRight, true
	case "justify":
		return docx.JustifyBoth, true
	default:
		return docx.JustifyLeft, false
	}
}

// indentLevelFromAttrs extracts the indent level from a PM attrs map, clamped
// to 0..MaxIndentLevel. JSON-decoded numbers arrive as float64; ints are
// handled for direct callers.
func indentLevelFromAttrs(attrs map[string]any) int {
	raw, ok := attrs["indent"]
	if !ok {
		return 0
	}
	var level int
	switch n := raw.(type) {
	case float64:
		level = int(n)
	case int:
		level = n
	default:
		return 0
	}
	if level < 0 {
		return 0
	}
	if level > MaxIndentLevel {
		return MaxIndentLevel
	}
	return level
}

// emitHeading adds a heading paragraph at the given level (clamped to 1..6),
// carrying the pStyle="HeadingN" that the importer keys off of.
func (b *builder) emitHeading(out *[]docx.Block, node PMNode) error {
	level := 1
	if v, ok := node.Attrs["level"].(float64); ok {
		level = int(v)
	} else if v, ok := node.Attrs["level"].(int); ok {
		level = v
	}
	if level < 1 {
		level = 1
	}
	if level > 6 {
		level = 6
	}
	props := b.paragraphProps(node.Attrs, fmt.Sprintf("Heading%d", level))
	content, err := b.inlineContent(node.Content)
	if err != nil {
		return err
	}
	*out = append(*out, docx.Block{Paragraph: &docx.Paragraph{Props: props, Content: content}})
	return nil
}

// emitList recursively emits a bulletList or orderedList. PM nests listItems
// containing paragraphs (and sub-lists); OOXML uses a flat paragraph stream
// sharing one NumID with the level carried on each item. We reuse the NumID
// within one logical PM list and allocate a fresh one per sibling list.
func (b *builder) emitList(out *[]docx.Block, node PMNode, listLevel int, listType string) error {
	prevScope := b.listScope
	b.listScope = makeFreshScope(prevScope, listLevel)
	defer func() { b.listScope = prevScope }()

	// Resumed ordered list: reuse the prior level-0 ordered NumID so the
	// importer's document-order continuation heuristic renumbers past a nested
	// bullet interruption.
	if listLevel == 0 && listType == NodeTypeOrderedList && b.lastOrderedNumIDAtLevel0 != 0 {
		if startVal, ok := node.Attrs["start"]; ok && asInt(startVal) > 1 {
			b.recordListNumID(0, b.lastOrderedNumIDAtLevel0)
		}
	}

	for _, item := range node.Content {
		if item.Type != NodeTypeListItem {
			return fmt.Errorf("translate: %s child must be listItem, got %q", listType, item.Type)
		}
		for _, child := range item.Content {
			switch child.Type {
			case NodeTypeParagraph:
				if err := b.emitBlock(out, child, listLevel, listType); err != nil {
					return err
				}
			case NodeTypeBulletList, NodeTypeOrderedList:
				if err := b.emitList(out, child, listLevel+1, child.Type); err != nil {
					return err
				}
			default:
				return fmt.Errorf("translate: unsupported listItem child %q", child.Type)
			}
		}
	}

	if listLevel == 0 && listType == NodeTypeOrderedList && listLevel < len(b.listScope) {
		if numID := b.listScope[0]; numID != 0 {
			b.lastOrderedNumIDAtLevel0 = numID
		}
	}
	return nil
}

// emitListParagraph appends one list-item paragraph carrying numPr + the
// ListParagraph style. The first item of a brand-new logical list allocates a
// fresh NumID (and its numbering instance); subsequent items reuse it.
func (b *builder) emitListParagraph(out *[]docx.Block, node PMNode, listLevel int, parentList string) error {
	var numID int
	if listLevel < len(b.listScope) && b.listScope[listLevel] != 0 {
		numID = b.listScope[listLevel]
	} else {
		numID = b.allocListNumID(parentList)
		b.recordListNumID(listLevel, numID)
	}

	props := docx.ParagraphProps{
		StyleID: "ListParagraph",
		HasNum:  true,
		NumID:   numID,
		ILvl:    listLevel,
	}
	if change := b.blockChangeFromAttrs(node.Attrs); change != nil {
		props.PPrChange = change
	}
	content, err := b.inlineContent(node.Content)
	if err != nil {
		return err
	}
	*out = append(*out, docx.Block{Paragraph: &docx.Paragraph{Props: props, Content: content}})
	return nil
}

// allocListNumID allocates a fresh numbering instance for a new logical list,
// wiring it to the shared bullet or ordered abstract definition (created
// lazily). Ordered instances carry a startOverride so Word restarts them (the
// importer ignores it, renumbering by document order).
func (b *builder) allocListNumID(listType string) int {
	numID := b.nextNumID
	b.nextNumID++
	if listType == NodeTypeBulletList {
		b.doc.Numbering.Instances[numID] = docx.NumInstance{AbstractID: b.bulletAbstract()}
	} else {
		b.doc.Numbering.Instances[numID] = docx.NumInstance{
			AbstractID: b.orderedAbstract(),
			Overrides:  map[int]docx.LevelOverride{0: {Start: 1, HasStart: true}},
		}
	}
	return numID
}

// bulletAbstract returns the shared bullet abstract-num id, creating it on
// first use. Levels rotate •/◦/▪ with per-level indent, matching docxwrite.
func (b *builder) bulletAbstract() int {
	if b.bulletAbstractID >= 0 {
		return b.bulletAbstractID
	}
	id := b.nextAbstractID
	b.nextAbstractID++
	glyphs := []string{"•", "◦", "▪"}
	levels := map[int]docx.NumLevel{}
	for lvl := 0; lvl < 9; lvl++ {
		ind := docx.Twips(720 * (lvl + 1))
		levels[lvl] = docx.NumLevel{
			Format: docx.NumFmtBullet, Text: glyphs[lvl%len(glyphs)],
			IndentLeft: ind, HasIndentLeft: true, Hanging: 360, HasHanging: true,
		}
	}
	b.doc.Numbering.Abstract[id] = levels
	b.bulletAbstractID = id
	return id
}

// orderedAbstract returns the shared decimal abstract-num id, creating it on
// first use. The %N lvlText placeholder is per-level.
func (b *builder) orderedAbstract() int {
	if b.orderedAbstractID >= 0 {
		return b.orderedAbstractID
	}
	id := b.nextAbstractID
	b.nextAbstractID++
	levels := map[int]docx.NumLevel{}
	for lvl := 0; lvl < 9; lvl++ {
		ind := docx.Twips(720 * (lvl + 1))
		levels[lvl] = docx.NumLevel{
			Format: docx.NumFmtDecimal, Text: fmt.Sprintf("%%%d.", lvl+1),
			Start: 1, HasStart: true,
			IndentLeft: ind, HasIndentLeft: true, Hanging: 360, HasHanging: true,
		}
	}
	b.doc.Numbering.Abstract[id] = levels
	b.orderedAbstractID = id
	return id
}

// recordListNumID stores the NumID for the current depth so the next sibling
// list-item at the same depth reuses it.
func (b *builder) recordListNumID(level, numID int) {
	for len(b.listScope) <= level {
		b.listScope = append(b.listScope, 0)
	}
	b.listScope[level] = numID
}

// makeFreshScope copies prev with the slot at level (and deeper) cleared — a
// new logical list gets a fresh NumID, not a sibling's.
func makeFreshScope(prev []int, level int) []int {
	out := make([]int, len(prev))
	copy(out, prev)
	for i := level; i < len(out); i++ {
		out[i] = 0
	}
	return out
}

// asInt coerces a JSON-decoded number (float64) or int to int.
func asInt(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	}
	return 0
}

// emitBlockquote unwraps a blockquote into its child paragraphs, applying the
// Quote pStyle to each. The block-change attr (attached at the blockquote
// level) rides the first inner paragraph's PPrChange.
func (b *builder) emitBlockquote(out *[]docx.Block, node PMNode) error {
	first := true
	for _, child := range node.Content {
		if child.Type != NodeTypeParagraph {
			return fmt.Errorf("translate: unsupported blockquote child %q", child.Type)
		}
		props := docx.ParagraphProps{StyleID: "Quote"}
		if first {
			if change := b.blockChangeFromAttrs(node.Attrs); change != nil {
				props.PPrChange = change
			}
			first = false
		}
		content, err := b.inlineContent(child.Content)
		if err != nil {
			return err
		}
		*out = append(*out, docx.Block{Paragraph: &docx.Paragraph{Props: props, Content: content}})
	}
	return nil
}

// emitCodeBlock emits a CodeBlock-styled paragraph carrying the node's plain
// text, with any embedded newlines broken by line-break runs so the importer
// re-joins them. The codeBlock schema carries no inline marks.
func (b *builder) emitCodeBlock(out *[]docx.Block, node PMNode) error {
	var text strings.Builder
	for _, child := range node.Content {
		if child.Type == NodeTypeText {
			text.WriteString(child.Text)
		}
	}
	props := docx.ParagraphProps{StyleID: "CodeBlock"}
	p := &docx.Paragraph{Props: props}
	if s := text.String(); s != "" {
		for i, line := range strings.Split(s, "\n") {
			if i > 0 {
				p.Content = append(p.Content, docx.ParaChild{Run: &docx.Run{Break: docx.BreakLine}})
			}
			if line != "" {
				p.Content = append(p.Content, docx.ParaChild{Run: &docx.Run{Text: line}})
			}
		}
	}
	*out = append(*out, docx.Block{Paragraph: p})
	return nil
}

// collectNodeText walks a PM subtree and concatenates the text of every
// descendant text node, joining distinct block children with a single space.
// Used to salvage the visible content of cell children the exporter flattens.
func collectNodeText(node PMNode) string {
	if node.Type == NodeTypeText {
		return node.Text
	}
	var parts []string
	for _, child := range node.Content {
		if t := collectNodeText(child); t != "" {
			parts = append(parts, t)
		}
	}
	return strings.Join(parts, " ")
}

// intAttr reads a positive numeric PM attr (JSON float64 / int / int64).
// Returns 0 for absent, non-numeric, or non-positive.
func intAttr(attrs map[string]any, key string) int {
	v, ok := attrs[key]
	if !ok || v == nil {
		return 0
	}
	switch n := v.(type) {
	case float64:
		if n <= 0 {
			return 0
		}
		return int(n)
	case int:
		if n <= 0 {
			return 0
		}
		return n
	case int64:
		if n <= 0 {
			return 0
		}
		return int(n)
	}
	return 0
}
