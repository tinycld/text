package translate

// WordZero API notes (from spike):
//
//   Construction:
//     doc := document.New()                                  -> *Document
//
//   Block-level adders (each returns the *Paragraph for further mutation):
//     doc.AddParagraph(text)                                 -> normal paragraph
//     doc.AddFormattedParagraph(text, *TextFormat)           -> first run is formatted
//     doc.AddHeadingParagraph(text, level int)               -> Heading{level}
//     doc.AddBulletList(text, level int, BulletType)         -> bullet list item
//     doc.AddNumberedList(text, level int, ListType)         -> ordered list item
//     doc.AddTable(*TableConfig)                             -> (*Table, error)
//
//   Inline runs on a paragraph:
//     p.AddFormattedText(text string, *TextFormat)           -> appends a run
//     TextFormat fields used: Bold, Italic, Underline (bool); FontColor (hex string)
//
//   Tables:
//     tbl, _ := doc.AddTable(&document.TableConfig{Rows, Cols, ColWidths})
//     tbl.AddCellParagraph(row, col, text)                   -> append a paragraph to a cell
//     tbl.SetCellText(row, col, text)                        -> replace cell with one run
//     tbl.AddCellFormattedText(row, col, text, *TextFormat)  -> append formatted run
//     tbl.ClearCellParagraphs(row, col)                      -> drop the default empty paragraph
//
//   Images:
//     doc.AddImageFromData(data []byte, name, ImageFormat, w, h, *ImageConfig)
//
//   Save / load:
//     doc.ToBytes() ([]byte, error)                          -> in-memory save (used here)
//     doc.Save(path string) error                            -> file save
//     document.OpenFromMemory(io.ReadCloser) (*Document, error)
//
//   Limitations relevant to v1:
//     - The Paragraph struct only exposes Runs []Run; there is no
//       hyperlink container at the public API level. To inject
//       <w:hyperlink r:id="rIdN"> wrappers around runs, we
//       post-process the saved zip: rewrite word/document.xml
//       (replace marker tokens with hyperlink open/close tags) and
//       extend word/_rels/document.xml.rels with the matching
//       Relationship rows. See pmToDocxLinkPostProcess().
//     - Blockquote: WordZero accepts SetStyle("Quote") on a
//       paragraph, but the default styles.xml doesn't define a Quote
//       style, so the visual rendering is unstyled. The pStyle pPr
//       does survive round-trip, which is what matters for fidelity.

import (
	"archive/zip"
	"bytes"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/url"
	"strconv"
	"strings"

	"github.com/ZeroHawkeye/wordZero/pkg/document"
)

// Silence WordZero's INFO-level chatter — every table create / cell
// clear / cell add prints to stdout by default. Errors still flow
// through err returns. We never want this in tests or production.
func init() {
	document.SetGlobalLevel(document.LogLevelSilent)
}

// PMJSONToDocx translates a ProseMirror JSON tree into .docx bytes.
// Returns an error if the JSON is malformed or contains node/mark
// types outside the supported set.
//
// Implementation strategy: drive WordZero for the bulk of the
// document (paragraphs, headings, lists, tables, blockquote-styled
// paragraphs, inline images). Hyperlinks are emitted as marker text
// runs, then post-processed: the marker tokens in word/document.xml
// are rewritten as <w:hyperlink r:id=…> wrappers and matching
// Relationship rows are appended to word/_rels/document.xml.rels.
func PMJSONToDocx(pmJSON []byte) ([]byte, error) {
	var root PMNode
	if err := json.Unmarshal(pmJSON, &root); err != nil {
		return nil, fmt.Errorf("translate: unmarshal pmJSON: %w", err)
	}
	if root.Type != NodeTypeDoc {
		return nil, fmt.Errorf("translate: pmJSON root must be type=doc, got %q", root.Type)
	}

	em := newEmitter()
	for _, child := range root.Content {
		if err := em.emitBlock(child, 0, ""); err != nil {
			return nil, err
		}
	}

	bs, err := em.doc.ToBytes()
	if err != nil {
		return nil, fmt.Errorf("translate: serialize docx: %w", err)
	}

	if len(em.linkRels) > 0 {
		bs, err = postProcessLinks(bs, em.linkRels)
		if err != nil {
			return nil, err
		}
	}
	return bs, nil
}

// emitter wraps a fresh WordZero document with the side state we
// need across recursive emitBlock calls — the chosen numId for the
// current top-level list, and the set of hyperlink relationships to
// be patched in post-process.
//
// listScope tracks which numId to use for the current bulletList /
// orderedList (and its nested children); set when we enter a list
// and cleared on exit. Reusing a numId across the items of one
// logical PM list is essential — WordZero's AddListItem allocates a
// fresh numId per call, which would (a) break round-trip grouping
// in the parser and (b) make every "bullet" render as a distinct
// list of one.
type emitter struct {
	doc       *document.Document
	linkRels  []linkRel
	linkSeq   int      // monotonic id for marker tokens
	listScope []string // numIds keyed by depth — one entry per nested list
}

type linkRel struct {
	Marker string // {{__pmlink:N:open}} … {{__pmlink:N:close}}
	Href   string
}

func newEmitter() *emitter {
	return &emitter{doc: document.New()}
}

// emitBlock dispatches on a block-level PMNode type. parentList is
// the WordZero list type we're inside (when called recursively from
// within a list item); listLevel is the current nesting depth.
func (em *emitter) emitBlock(node PMNode, listLevel int, parentList string) error {
	switch node.Type {
	case NodeTypeParagraph:
		return em.emitParagraph(node, listLevel, parentList)
	case NodeTypeHeading:
		return em.emitHeading(node)
	case NodeTypeBulletList:
		return em.emitList(node, listLevel, NodeTypeBulletList)
	case NodeTypeOrderedList:
		return em.emitList(node, listLevel, NodeTypeOrderedList)
	case NodeTypeBlockquote:
		return em.emitBlockquote(node)
	case NodeTypeTable:
		return em.emitTable(node)
	case NodeTypeImage:
		return em.emitImageBlock(node)
	default:
		return fmt.Errorf("translate: unsupported block node type %q", node.Type)
	}
}

// emitParagraph emits a normal paragraph (or, when called inside a
// list, the list-item's paragraph that carries the numId+ilvl into
// OOXML).
func (em *emitter) emitParagraph(node PMNode, listLevel int, parentList string) error {
	if parentList != "" {
		return em.emitListParagraph(node, listLevel, parentList)
	}
	p := em.doc.AddParagraph("")
	return em.emitInlineRuns(p, node.Content)
}

// emitListParagraph appends one list-item paragraph. The first
// item of a brand-new logical list calls AddBulletList /
// AddNumberedList so WordZero's NumberingManager seeds the
// numbering.xml entry; subsequent items reuse that same numId
// directly (via Body.AddElement on a hand-built Paragraph), which
// keeps all items of one logical PM list grouped under one numId in
// OOXML — that's what the parser uses to reconstruct the list shape.
func (em *emitter) emitListParagraph(node PMNode, listLevel int, parentList string) error {
	var p *document.Paragraph
	if listLevel < len(em.listScope) && em.listScope[listLevel] != "" {
		// Reuse — append a paragraph whose numId we know.
		p = em.appendListParagraphReusingNumID(em.listScope[listLevel], listLevel)
	} else {
		// First item of this list — let WordZero allocate the numId.
		p = em.appendFirstListParagraph(parentList, listLevel)
		em.recordListNumID(listLevel, extractNumID(p))
	}
	return em.emitInlineRuns(p, node.Content)
}

// appendFirstListParagraph creates the first paragraph in a new
// logical list — used to coax WordZero into allocating a fresh numId
// and seeding numbering.xml.
func (em *emitter) appendFirstListParagraph(listType string, level int) *document.Paragraph {
	if listType == NodeTypeBulletList {
		return em.doc.AddBulletList("", level, document.BulletTypeDot)
	}
	return em.doc.AddNumberedList("", level, document.ListTypeDecimal)
}

// appendListParagraphReusingNumID appends a paragraph whose pPr
// references the given numId+ilvl, bypassing WordZero's numbering
// allocator (which would burn a fresh numId).
func (em *emitter) appendListParagraphReusingNumID(numID string, level int) *document.Paragraph {
	p := &document.Paragraph{
		Properties: &document.ParagraphProperties{
			NumberingProperties: &document.NumberingProperties{
				ILevel: &document.ILevel{Val: strconv.Itoa(level)},
				NumID:  &document.NumID{Val: numID},
			},
		},
	}
	em.doc.Body.AddElement(p)
	return p
}

// recordListNumID stores the numId for the current depth so the
// next sibling list-item at the same depth can reuse it.
func (em *emitter) recordListNumID(level int, numID string) {
	for len(em.listScope) <= level {
		em.listScope = append(em.listScope, "")
	}
	em.listScope[level] = numID
}

// extractNumID pulls the numId WordZero allocated for a list
// paragraph out of its ParagraphProperties. Returns "" if the
// structure is unexpected (which shouldn't happen for paragraphs
// returned by AddBulletList / AddNumberedList).
func extractNumID(p *document.Paragraph) string {
	if p == nil || p.Properties == nil || p.Properties.NumberingProperties == nil {
		return ""
	}
	if p.Properties.NumberingProperties.NumID == nil {
		return ""
	}
	return p.Properties.NumberingProperties.NumID.Val
}

// emitHeading adds a heading paragraph at the given level (clamped
// to 1..6 per the v1 schema), then re-applies the runs so each
// portion can carry its own marks.
func (em *emitter) emitHeading(node PMNode) error {
	level := 1
	if v, ok := node.Attrs["level"].(float64); ok {
		level = int(v)
	}
	if level < 1 {
		level = 1
	}
	if level > 6 {
		level = 6
	}
	p := em.doc.AddHeadingParagraph("", level)
	return em.emitInlineRuns(p, node.Content)
}

// emitList recursively emits a bulletList or orderedList. PM nests
// listItems containing paragraphs; OOXML uses a flat paragraph
// stream with shared numId. We collapse PM's structure onto a flat
// stream, propagating the level through nested recursive calls and
// reusing numIds within one logical list.
//
// The listScope slot at this depth is cleared on entry and reset
// when we leave the call; that way two sibling top-level lists each
// get their own numId (correct behavior — different lists shouldn't
// share numbering).
func (em *emitter) emitList(node PMNode, listLevel int, listType string) error {
	prevScope := em.listScope
	em.listScope = makeFreshScope(prevScope, listLevel)
	defer func() { em.listScope = prevScope }()

	for _, item := range node.Content {
		if item.Type != NodeTypeListItem {
			return fmt.Errorf("translate: %s child must be listItem, got %q", listType, item.Type)
		}
		for _, child := range item.Content {
			switch child.Type {
			case NodeTypeParagraph:
				if err := em.emitBlock(child, listLevel, listType); err != nil {
					return err
				}
			case NodeTypeBulletList, NodeTypeOrderedList:
				if err := em.emitList(child, listLevel+1, child.Type); err != nil {
					return err
				}
			default:
				return fmt.Errorf("translate: unsupported listItem child %q", child.Type)
			}
		}
	}
	return nil
}

// makeFreshScope returns a copy of prev with the slot at level
// (and all deeper slots) cleared. Used when entering a new logical
// list — we want to allocate a fresh numId for it, not reuse a
// previous sibling list's numId.
func makeFreshScope(prev []string, level int) []string {
	out := make([]string, len(prev))
	copy(out, prev)
	for i := level; i < len(out); i++ {
		out[i] = ""
	}
	return out
}

// emitBlockquote unwraps a blockquote into its child paragraphs,
// applying the "Quote" pStyle to each one. PM nests paragraphs
// inside the blockquote; OOXML has no real container element for
// blockquotes, so we mark each paragraph individually.
func (em *emitter) emitBlockquote(node PMNode) error {
	for _, child := range node.Content {
		switch child.Type {
		case NodeTypeParagraph:
			p := em.doc.AddParagraph("")
			p.SetStyle("Quote")
			if err := em.emitInlineRuns(p, child.Content); err != nil {
				return err
			}
		default:
			return fmt.Errorf("translate: unsupported blockquote child %q", child.Type)
		}
	}
	return nil
}

// emitTable creates a WordZero table sized to the PM rows/cols and
// pours each cell's content into AddCellParagraph / AddFormattedText.
func (em *emitter) emitTable(node PMNode) error {
	rows := len(node.Content)
	if rows == 0 {
		return nil
	}
	cols := 0
	for _, row := range node.Content {
		if row.Type != NodeTypeTableRow {
			continue
		}
		if c := len(row.Content); c > cols {
			cols = c
		}
	}
	if cols == 0 {
		return nil
	}
	tbl, err := em.doc.AddTable(&document.TableConfig{Rows: rows, Cols: cols})
	if err != nil {
		return fmt.Errorf("translate: create table: %w", err)
	}
	for r, row := range node.Content {
		if row.Type != NodeTypeTableRow {
			continue
		}
		for c, cell := range row.Content {
			if cell.Type != NodeTypeTableCell {
				continue
			}
			if err := em.emitTableCell(tbl, r, c, cell); err != nil {
				return err
			}
		}
	}
	return nil
}

// emitTableCell writes one cell. We clear the default placeholder
// paragraph WordZero seeded into the cell, then append a paragraph
// per PM child paragraph and pour runs into it.
//
// Caveat: WordZero's ClearCellParagraphs + AddCellParagraph still
// leaves an extra empty <w:p> in each cell. The round-trip test
// works around this by concatenating text from all paragraphs in
// each cell — a faithful round-trip would need either a WordZero fix
// or hand-rolling the cell XML. Acceptable for v1 since the visible
// content survives intact.
func (em *emitter) emitTableCell(tbl *document.Table, row, col int, cell PMNode) error {
	if err := tbl.ClearCellParagraphs(row, col); err != nil {
		return fmt.Errorf("translate: clear cell %d,%d: %w", row, col, err)
	}
	for _, child := range cell.Content {
		if child.Type != NodeTypeParagraph {
			// v1 schema forbids non-paragraph block content in a cell.
			return fmt.Errorf("translate: tableCell content must be paragraph, got %q", child.Type)
		}
		para, err := tbl.AddCellParagraph(row, col, "")
		if err != nil {
			return fmt.Errorf("translate: add cell para: %w", err)
		}
		if err := em.emitInlineRuns(para, child.Content); err != nil {
			return err
		}
	}
	return nil
}

// emitImageBlock embeds a block-level image. v1 supports data: URIs
// and embedded images via AddImageFromData. Network URLs are
// rejected for now (caller should pre-fetch); see report.
func (em *emitter) emitImageBlock(node PMNode) error {
	src, _ := node.Attrs["src"].(string)
	if src == "" {
		return fmt.Errorf("translate: image node missing src attr")
	}
	data, format, err := decodeImageSrc(src)
	if err != nil {
		return err
	}
	cfg := &document.ImageConfig{}
	if alt, ok := node.Attrs["alt"].(string); ok && alt != "" {
		cfg.AltText = alt
	}
	if title, ok := node.Attrs["title"].(string); ok && title != "" {
		cfg.Title = title
	}
	_, err = em.doc.AddImageFromData(data, deriveImageName(src, format), format, 0, 0, cfg)
	if err != nil {
		return fmt.Errorf("translate: add image: %w", err)
	}
	return nil
}

// decodeImageSrc accepts either a data: URI ("data:image/png;base64,…")
// or a file:// path. Returns the raw bytes plus the WordZero
// ImageFormat enum.
func decodeImageSrc(src string) ([]byte, document.ImageFormat, error) {
	if strings.HasPrefix(src, "data:") {
		return decodeDataURI(src)
	}
	return nil, "", fmt.Errorf("translate: unsupported image src %q (only data: URIs supported in v1)", src)
}

func decodeDataURI(src string) ([]byte, document.ImageFormat, error) {
	comma := strings.IndexByte(src, ',')
	if comma < 0 {
		return nil, "", fmt.Errorf("translate: malformed data URI")
	}
	header := src[:comma]
	body := src[comma+1:]
	mediaType := strings.TrimPrefix(header, "data:")
	mediaType = strings.SplitN(mediaType, ";", 2)[0]
	format := mediaTypeToFormat(mediaType)
	if format == "" {
		return nil, "", fmt.Errorf("translate: unsupported image media type %q", mediaType)
	}
	if !strings.Contains(header, "base64") {
		// raw URL-encoded content
		decoded, err := url.QueryUnescape(body)
		if err != nil {
			return nil, "", fmt.Errorf("translate: decode data URI: %w", err)
		}
		return []byte(decoded), format, nil
	}
	data, err := base64.StdEncoding.DecodeString(body)
	if err != nil {
		return nil, "", fmt.Errorf("translate: decode base64: %w", err)
	}
	return data, format, nil
}

func mediaTypeToFormat(media string) document.ImageFormat {
	switch strings.ToLower(media) {
	case "image/png":
		return document.ImageFormatPNG
	case "image/jpeg", "image/jpg":
		return document.ImageFormatJPEG
	case "image/gif":
		return document.ImageFormatGIF
	}
	return ""
}

// deriveImageName makes up a deterministic filename for the
// embedded media file. Using a sha1 of the src keeps the same image
// from being duplicated when the same data: URI appears twice.
func deriveImageName(src string, format document.ImageFormat) string {
	h := sha1.Sum([]byte(src))
	ext := "png"
	switch format {
	case document.ImageFormatJPEG:
		ext = "jpg"
	case document.ImageFormatGIF:
		ext = "gif"
	}
	return fmt.Sprintf("img_%x.%s", h[:6], ext)
}

// emitInlineRuns appends every PMNode child as an inline run on the
// supplied paragraph. Text nodes become AddFormattedText runs;
// link-marked text is wrapped in marker tokens that are post-
// processed into <w:hyperlink>; image nodes inside a paragraph are
// added via AddImageFromData (inline anchor).
func (em *emitter) emitInlineRuns(p *document.Paragraph, runs []PMNode) error {
	for _, r := range runs {
		switch r.Type {
		case NodeTypeText:
			if err := em.emitTextRun(p, r); err != nil {
				return err
			}
		case NodeTypeImage:
			if err := em.emitInlineImage(r); err != nil {
				return err
			}
		default:
			return fmt.Errorf("translate: unsupported inline node %q", r.Type)
		}
	}
	return nil
}

// emitTextRun is the workhorse: convert PM marks into a WordZero
// TextFormat and append the run. If the node carries a link mark,
// we wrap the text in linkOpen/linkClose marker tokens — those get
// rewritten into <w:hyperlink r:id=…> in postProcessLinks.
func (em *emitter) emitTextRun(p *document.Paragraph, node PMNode) error {
	if node.Text == "" {
		return nil
	}
	href, hasLink := linkHref(node.Marks)
	fmt := marksToTextFormat(node.Marks)
	if hasLink {
		// Surround the run with markers; the post-process step
		// recognizes them in word/document.xml and rewrites the
		// flanking content.
		em.linkSeq++
		em.linkRels = append(em.linkRels, linkRel{
			Marker: linkMarkerID(em.linkSeq),
			Href:   href,
		})
		open := linkOpenToken(em.linkSeq)
		closeTok := linkCloseToken(em.linkSeq)
		// Each surrounding marker is its own bare text run so that
		// the post-processor can locate them in document.xml without
		// ambiguity. Pass an empty (not nil) TextFormat — WordZero's
		// AddFormattedText drops the text entirely when format==nil.
		empty := &document.TextFormat{}
		p.AddFormattedText(open, empty)
		p.AddFormattedText(node.Text, fmt)
		p.AddFormattedText(closeTok, empty)
		return nil
	}
	p.AddFormattedText(node.Text, fmt)
	return nil
}

// emitInlineImage adds an inline image to the document. WordZero's
// AddImageFromData attaches to the document body, not to a specific
// paragraph — for v1 we accept that limitation (inline images
// appear next to, not strictly inside, the paragraph they're
// declared in).
func (em *emitter) emitInlineImage(node PMNode) error {
	return em.emitImageBlock(node)
}

// marksToTextFormat builds a TextFormat reflecting the bold/italic/
// underline marks. Link marks (which need href resolution) are
// handled separately in emitTextRun.
func marksToTextFormat(marks []PMMark) *document.TextFormat {
	if len(marks) == 0 {
		return nil
	}
	fmt := &document.TextFormat{}
	any := false
	for _, m := range marks {
		switch m.Type {
		case MarkTypeBold:
			fmt.Bold = true
			any = true
		case MarkTypeItalic:
			fmt.Italic = true
			any = true
		case MarkTypeUnderline:
			fmt.Underline = true
			any = true
		case MarkTypeLink:
			// Link marks are emitted as a wrapping <w:hyperlink>;
			// they also conventionally render with underline + accent
			// color in Word, so we add those visual cues here.
			fmt.Underline = true
			fmt.FontColor = "0563C1"
			any = true
		}
	}
	if !any {
		return nil
	}
	return fmt
}

func linkHref(marks []PMMark) (string, bool) {
	for _, m := range marks {
		if m.Type == MarkTypeLink {
			if href, ok := m.Attrs["href"].(string); ok && href != "" {
				return href, true
			}
		}
	}
	return "", false
}

// linkMarkerID / linkOpenToken / linkCloseToken produce the
// placeholder strings that we wrap link runs with. Designed to be
// unlikely-as-real-text; postProcessLinks looks for these exact
// token strings in word/document.xml.
func linkMarkerID(n int) string { return strconv.Itoa(n) }
func linkOpenToken(n int) string {
	return "{{__pmlink:" + linkMarkerID(n) + ":open}}"
}
func linkCloseToken(n int) string {
	return "{{__pmlink:" + linkMarkerID(n) + ":close}}"
}

// postProcessLinks rewrites the docx zip in-place to convert
// linkOpen/linkClose marker text runs into proper <w:hyperlink>
// wrappers, and appends the matching Relationship rows to
// word/_rels/document.xml.rels.
func postProcessLinks(docxBytes []byte, rels []linkRel) ([]byte, error) {
	zr, err := zip.NewReader(bytes.NewReader(docxBytes), int64(len(docxBytes)))
	if err != nil {
		return nil, fmt.Errorf("translate: re-read for link postprocess: %w", err)
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
	relsXML := parts["word/_rels/document.xml.rels"]

	docXML, relsXML = applyLinkRewrites(docXML, relsXML, rels)

	parts["word/document.xml"] = docXML
	parts["word/_rels/document.xml.rels"] = relsXML

	return rezipParts(zr, parts)
}

// pendingRel is one rId+Href pair to inject into the rels XML;
// declared at package scope so it can flow through appendRelationships
// and applyLinkRewrites without compiler-confusing nested types.
type pendingRel struct {
	ID   string
	Href string
}

// applyLinkRewrites walks the marker token list, finds each
// open+content+close span in document.xml, and replaces it with a
// proper <w:hyperlink r:id="rIdN"> ... </w:hyperlink>. Also
// extends the rels XML with a Relationship row per link.
func applyLinkRewrites(docXML, relsXML []byte, rels []linkRel) ([]byte, []byte) {
	if len(rels) == 0 {
		return docXML, relsXML
	}
	doc := string(docXML)
	rid := nextRid(string(relsXML))
	var pending []pendingRel
	for _, l := range rels {
		open := linkOpenToken(parseMarkerSeq(l.Marker))
		closeMarker := linkCloseToken(parseMarkerSeq(l.Marker))
		// In document.xml each marker text becomes a
		// <w:r><w:t>{{__pmlink:N:open}}</w:t></w:r> run. We rewrite:
		//   <w:r>…<w:t>OPEN</w:t></w:r>
		//   <w:r>…<w:t>TEXT</w:t></w:r>
		//   <w:r>…<w:t>CLOSE</w:t></w:r>
		// into
		//   <w:hyperlink r:id="rIdN" w:history="1">
		//     <w:r>…<w:t>TEXT</w:t></w:r>
		//   </w:hyperlink>
		openRun, openIdx := findMarkerRun(doc, open)
		if openIdx < 0 {
			continue
		}
		closeRun, closeIdxRel := findMarkerRun(doc[openIdx+len(openRun):], closeMarker)
		if closeIdxRel < 0 {
			continue
		}
		closeStart := openIdx + len(openRun) + closeIdxRel
		closeEnd := closeStart + len(closeRun)
		inner := doc[openIdx+len(openRun) : closeStart]
		ridStr := "rId" + strconv.Itoa(rid)
		rid++
		hyper := `<w:hyperlink r:id="` + ridStr + `" w:history="1">` + inner + `</w:hyperlink>`
		doc = doc[:openIdx] + hyper + doc[closeEnd:]
		pending = append(pending, pendingRel{ID: ridStr, Href: l.Href})
	}
	relsOut := appendRelationships(string(relsXML), pending)
	return []byte(doc), []byte(relsOut)
}

// findMarkerRun locates a <w:r ...><w:t>marker</w:t></w:r> in the
// supplied haystack and returns (the matched run substring, its
// start offset). The marker may be wrapped in xml:space="preserve"
// or include attributes — we anchor on the marker text inside <w:t>.
//
// We carefully look back for the OPENING run tag (<w:r> or <w:r ...>),
// not for any token that happens to start with "<w:r" — the latter
// would also match <w:rPr> on the immediately-enclosing run, and we
// would chop the run open in the wrong place.
func findMarkerRun(haystack, marker string) (string, int) {
	needle := ">" + marker + "</w:t>"
	pos := strings.Index(haystack, needle)
	if pos < 0 {
		return "", -1
	}
	startOffset := lastRunOpen(haystack[:pos])
	if startOffset < 0 {
		return "", -1
	}
	endOffset := strings.Index(haystack[pos:], "</w:r>")
	if endOffset < 0 {
		return "", -1
	}
	endAbs := pos + endOffset + len("</w:r>")
	return haystack[startOffset:endAbs], startOffset
}

// lastRunOpen returns the offset of the last <w:r> or <w:r ...> tag
// in s — it ignores <w:rPr>, <w:rStyle>, etc. by requiring the
// character after "<w:r" to be ">" or whitespace.
func lastRunOpen(s string) int {
	for off := len(s); off > 0; {
		idx := strings.LastIndex(s[:off], "<w:r")
		if idx < 0 {
			return -1
		}
		if idx+4 < len(s) {
			next := s[idx+4]
			if next == '>' || next == ' ' || next == '\t' || next == '\n' || next == '\r' || next == '/' {
				return idx
			}
		}
		off = idx
	}
	return -1
}

// nextRid scans the rels XML for the highest existing rId number and
// returns the next free integer.
func nextRid(rels string) int {
	max := 0
	idx := 0
	for {
		i := strings.Index(rels[idx:], `Id="rId`)
		if i < 0 {
			break
		}
		i += idx
		j := strings.Index(rels[i+7:], `"`)
		if j < 0 {
			break
		}
		n, err := strconv.Atoi(rels[i+7 : i+7+j])
		if err == nil && n > max {
			max = n
		}
		idx = i + 7 + j
	}
	return max + 1
}

// appendRelationships injects new <Relationship> rows just before
// the closing </Relationships>.
func appendRelationships(rels string, pending []pendingRel) string {
	if len(pending) == 0 {
		return rels
	}
	closeTag := "</Relationships>"
	idx := strings.LastIndex(rels, closeTag)
	if idx < 0 {
		return rels
	}
	var sb strings.Builder
	sb.WriteString(rels[:idx])
	for _, p := range pending {
		sb.WriteString(`<Relationship Id="`)
		sb.WriteString(p.ID)
		sb.WriteString(`" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="`)
		sb.WriteString(xmlEscape(p.Href))
		sb.WriteString(`" TargetMode="External"/>`)
	}
	sb.WriteString(rels[idx:])
	return sb.String()
}

func xmlEscape(s string) string {
	var sb strings.Builder
	if err := xml.EscapeText(&sb, []byte(s)); err != nil {
		return s
	}
	return sb.String()
}

// parseMarkerSeq pulls the integer back out of a marker ID string.
func parseMarkerSeq(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

// rezipParts builds a new ZIP archive from the (mutated) parts map,
// preserving the original file ordering and storage method.
func rezipParts(orig *zip.Reader, parts map[string][]byte) ([]byte, error) {
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for _, f := range orig.File {
		header := &zip.FileHeader{
			Name:   f.Name,
			Method: f.Method,
		}
		// Preserve well-known DOS epoch timestamps WordZero uses.
		header.SetModTime(f.Modified)
		out, err := w.CreateHeader(header)
		if err != nil {
			return nil, err
		}
		if _, err := out.Write(parts[f.Name]); err != nil {
			return nil, err
		}
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
