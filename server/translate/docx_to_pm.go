package translate

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"path"
	"strconv"
	"strings"
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
func DocxToPMJSON(docx []byte) ([]byte, []Warning, error) {
	zr, err := zip.NewReader(bytes.NewReader(docx), int64(len(docx)))
	if err != nil {
		return nil, nil, fmt.Errorf("translate: open docx as zip: %w", err)
	}

	parts, err := readZipParts(zr)
	if err != nil {
		return nil, nil, err
	}

	docXML, ok := parts["word/document.xml"]
	if !ok {
		return nil, nil, fmt.Errorf("translate: docx missing word/document.xml")
	}

	rels := parseRelationships(parts["word/_rels/document.xml.rels"])
	numbering := parseNumberingFormats(parts["word/numbering.xml"])

	parser := docxParser{
		zip:       zr,
		rels:      rels,
		numbering: numbering,
		hasComments: hasPart(parts, "word/comments.xml") ||
			hasContent(docXML, "<w:commentRangeStart") ||
			hasContent(docXML, "<w:commentReference"),
	}

	root, err := parser.parseDocument(docXML)
	if err != nil {
		return nil, nil, fmt.Errorf("translate: parse document.xml: %w", err)
	}

	out, err := json.Marshal(root)
	if err != nil {
		return nil, nil, fmt.Errorf("translate: marshal root: %w", err)
	}
	return out, parser.warnings, nil
}

// readZipParts collects the bytes of every file in the docx zip.
func readZipParts(zr *zip.Reader) (map[string][]byte, error) {
	parts := make(map[string][]byte, len(zr.File))
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			return nil, fmt.Errorf("translate: open %s: %w", f.Name, err)
		}
		buf, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			return nil, fmt.Errorf("translate: read %s: %w", f.Name, err)
		}
		parts[f.Name] = buf
	}
	return parts, nil
}

func hasPart(parts map[string][]byte, name string) bool {
	_, ok := parts[name]
	return ok
}

func hasContent(b []byte, needle string) bool {
	return bytes.Contains(b, []byte(needle))
}

// docxParser holds the state shared across paragraph/run/table parses
// so we don't have to thread a half-dozen arguments through every call.
type docxParser struct {
	zip         *zip.Reader              // open docx zip for reading media bytes
	rels        map[string]relationship  // rId -> relationship target
	numbering   map[string]string        // numId -> "bullet" or "decimal"
	hasComments bool                     // true if comments.xml or commentRange* present
	warnings    []Warning                // accumulated soft-degradation signals
	warningSet  map[WarningCode]struct{} // dedupe
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

// relationship is one Relationship row out of word/_rels/document.xml.rels;
// Type tells us hyperlink vs image vs other; Target is the URL or media path.
type relationship struct {
	Type       string
	Target     string
	TargetMode string
}

// parseRelationships reads document.xml.rels into a map keyed by rId.
// Returns nil-tolerant: a missing or malformed relationships file
// just produces an empty map (callers treat unknown rIds gracefully).
func parseRelationships(b []byte) map[string]relationship {
	if len(b) == 0 {
		return nil
	}
	type relXML struct {
		ID         string `xml:"Id,attr"`
		Type       string `xml:"Type,attr"`
		Target     string `xml:"Target,attr"`
		TargetMode string `xml:"TargetMode,attr"`
	}
	var doc struct {
		XMLName xml.Name `xml:"Relationships"`
		Rels    []relXML `xml:"Relationship"`
	}
	if err := xml.Unmarshal(b, &doc); err != nil {
		return nil
	}
	m := make(map[string]relationship, len(doc.Rels))
	for _, r := range doc.Rels {
		m[r.ID] = relationship{Type: r.Type, Target: r.Target, TargetMode: r.TargetMode}
	}
	return m
}

// parseNumberingFormats reads word/numbering.xml and returns a map
// from numId to its first-level numFmt ("bullet", "decimal",
// "lowerLetter", "lowerRoman", etc.). We use the first level's format
// to decide whether the whole list is a bulletList or orderedList in
// PM (PM has no per-level format distinction).
func parseNumberingFormats(b []byte) map[string]string {
	if len(b) == 0 {
		return nil
	}
	type lvlXML struct {
		ILvl   string `xml:"ilvl,attr"`
		NumFmt struct {
			Val string `xml:"val,attr"`
		} `xml:"numFmt"`
	}
	type abstractXML struct {
		ID   string   `xml:"abstractNumId,attr"`
		Lvls []lvlXML `xml:"lvl"`
	}
	type numXML struct {
		NumID         string `xml:"numId,attr"`
		AbstractNumID struct {
			Val string `xml:"val,attr"`
		} `xml:"abstractNumId"`
	}
	var root struct {
		XMLName      xml.Name      `xml:"numbering"`
		AbstractNums []abstractXML `xml:"abstractNum"`
		Nums         []numXML      `xml:"num"`
	}
	if err := xml.Unmarshal(b, &root); err != nil {
		return nil
	}
	abstracts := make(map[string]string, len(root.AbstractNums))
	for _, a := range root.AbstractNums {
		for _, l := range a.Lvls {
			if l.ILvl == "0" || l.ILvl == "" {
				abstracts[a.ID] = l.NumFmt.Val
				break
			}
		}
	}
	out := make(map[string]string, len(root.Nums))
	for _, n := range root.Nums {
		out[n.NumID] = abstracts[n.AbstractNumID.Val]
	}
	return out
}

// parseDocument is the entry point for word/document.xml — it walks
// the body and produces a doc-level PMNode. List paragraphs (which
// are flat in OOXML) are post-processed into nested bulletList /
// orderedList / listItem trees.
func (p *docxParser) parseDocument(docXML []byte) (PMNode, error) {
	root := PMNode{Type: NodeTypeDoc}

	dec := xml.NewDecoder(bytes.NewReader(docXML))
	body, err := findElement(dec, "body")
	if err != nil {
		return PMNode{}, err
	}

	// Walk body children.
	flat, err := p.parseBodyChildren(dec, body)
	if err != nil {
		return PMNode{}, err
	}
	root.Content = groupListParagraphs(flat)
	return root, nil
}

// findElement scans forward from the decoder until it hits a
// StartElement with the given local name, then returns it.
func findElement(dec *xml.Decoder, local string) (xml.StartElement, error) {
	for {
		tok, err := dec.Token()
		if err != nil {
			return xml.StartElement{}, fmt.Errorf("translate: looking for <%s>: %w", local, err)
		}
		if start, ok := tok.(xml.StartElement); ok && start.Name.Local == local {
			return start, nil
		}
	}
}

// parseBodyChildren consumes tokens until the closing </body> tag,
// emitting flat block-level PMNodes. The flat list is later post-
// processed by groupListParagraphs into proper PM list trees.
func (p *docxParser) parseBodyChildren(dec *xml.Decoder, body xml.StartElement) ([]PMNode, error) {
	var out []PMNode
	for {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			node, err := p.parseBodyChild(dec, t)
			if err != nil {
				return nil, err
			}
			if node != nil {
				out = append(out, liftInlineImages(*node)...)
			}
		case xml.EndElement:
			if t.Name.Local == body.Name.Local {
				return out, nil
			}
		}
	}
}

// liftInlineImages splits a paragraph that mixes text and image runs
// into a sequence of sibling block-level nodes: one paragraph per text
// span, plus the bare image node between/around them. PM treats image
// as a block-level node and pm_to_docx emits it via WordZero's
// AddImageFromData, which always writes the image into its own
// top-level <w:p>. Lifting at parse time keeps round-trip stable —
// otherwise the inline-mixed pass-1 tree always diverges from the
// post-emit pass-3 tree.
//
// Non-paragraph nodes (tables, headings, image-only paragraphs)
// pass through unchanged. Empty-after-lift paragraphs are dropped.
func liftInlineImages(node PMNode) []PMNode {
	if node.Type != NodeTypeParagraph {
		return []PMNode{node}
	}
	hasImage := false
	for _, c := range node.Content {
		if c.Type == NodeTypeImage {
			hasImage = true
			break
		}
	}
	if !hasImage {
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
		if c.Type == NodeTypeImage {
			flush()
			out = append(out, c)
			continue
		}
		buf = append(buf, c)
	}
	flush()
	return out
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

// parseBodyChild handles one direct child of <w:body>.
func (p *docxParser) parseBodyChild(dec *xml.Decoder, start xml.StartElement) (*PMNode, error) {
	switch start.Name.Local {
	case "p":
		return p.parseParagraph(dec, start)
	case "tbl":
		return p.parseTable(dec, start)
	case "sectPr":
		// Section properties (page setup) — silently skip; not
		// representable in PM and not user-content.
		return nil, skipElement(dec, start)
	case "sdt":
		// Structured document tag (content control). Replace with
		// inner text and warn.
		p.addWarning(WarningContentControls, "<w:sdt> elements were unwrapped to their inner text")
		return p.parseSdt(dec, start)
	default:
		p.addWarning(WarningUnsupportedNode, fmt.Sprintf("unknown body child <%s> dropped", start.Name.Local))
		return nil, skipElement(dec, start)
	}
}

// parseParagraph reads one <w:p> and returns either a PM paragraph,
// heading, blockquote, or — when wrapped by a parent context like a
// table cell — a paragraph regardless of pStyle.
func (p *docxParser) parseParagraph(dec *xml.Decoder, start xml.StartElement) (*PMNode, error) {
	var pStyle string
	var numID, ilvl string
	var runs []PMNode

	for {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "pPr":
				if err := p.parseParagraphProperties(dec, t, &pStyle, &numID, &ilvl); err != nil {
					return nil, err
				}
			case "r":
				if err := p.parseRun(dec, t, &runs, nil); err != nil {
					return nil, err
				}
			case "hyperlink":
				if err := p.parseHyperlink(dec, t, &runs); err != nil {
					return nil, err
				}
			case "ins":
				// Tracked insertion — we accept the inserted text and warn.
				p.addWarning(WarningTrackedChanges, "<w:ins> tracked insertions accepted as plain text")
				if err := p.parseInlineGroup(dec, t, &runs); err != nil {
					return nil, err
				}
			case "del":
				p.addWarning(WarningTrackedChanges, "<w:del> tracked deletions dropped")
				if err := skipElement(dec, t); err != nil {
					return nil, err
				}
			case "commentRangeStart", "commentRangeEnd", "commentReference":
				p.addWarning(WarningComments, "comment markers stripped from paragraph")
				if err := skipElement(dec, t); err != nil {
					return nil, err
				}
			case "bookmarkStart", "bookmarkEnd", "proofErr", "permStart", "permEnd":
				if err := skipElement(dec, t); err != nil {
					return nil, err
				}
			default:
				if err := skipElement(dec, t); err != nil {
					return nil, err
				}
			}
		case xml.EndElement:
			if t.Name.Local == start.Name.Local {
				return p.assembleParagraph(pStyle, numID, ilvl, runs), nil
			}
		}
	}
}

// assembleParagraph turns the parsed pPr fields and runs into a PM
// node — heading / paragraph / blockquote, with metadata for list
// post-processing tucked into Attrs. The temporary attrs are stripped
// by groupListParagraphs.
func (p *docxParser) assembleParagraph(pStyle, numID, ilvl string, runs []PMNode) *PMNode {
	// Empty paragraph (no runs) is still a valid PM paragraph node;
	// blank lines in OOXML translate to empty PM paragraphs.
	if numID != "" {
		// List item — emit a bare paragraph carrying list metadata
		// in Attrs; groupListParagraphs will gather these and rebuild
		// the bulletList/orderedList tree.
		return &PMNode{
			Type:    NodeTypeParagraph,
			Content: runs,
			Attrs: map[string]any{
				"_listNumId": numID,
				"_listLevel": ilvlToInt(ilvl),
				"_listFmt":   p.numbering[numID],
			},
		}
	}

	switch {
	case strings.HasPrefix(pStyle, "Heading"):
		level := headingLevel(pStyle)
		if level < 1 || level > 6 {
			p.addWarning(WarningUnsupportedStyle, fmt.Sprintf("heading level %d outside 1-6 normalized to 6", level))
			level = 6
		}
		return &PMNode{
			Type:    NodeTypeHeading,
			Attrs:   map[string]any{"level": float64(level)},
			Content: runs,
		}
	case pStyle == "Quote" || pStyle == "IntenseQuote":
		// Wrap a quote paragraph in a blockquote with one paragraph child.
		return &PMNode{
			Type: NodeTypeBlockquote,
			Content: []PMNode{
				{Type: NodeTypeParagraph, Content: runs},
			},
		}
	case pStyle != "" && pStyle != "Normal" && pStyle != "ListParagraph":
		// Unknown style — fall back to plain paragraph with a warning.
		p.addWarning(WarningUnsupportedStyle, fmt.Sprintf("paragraph style %q normalized to default paragraph", pStyle))
	}

	return &PMNode{Type: NodeTypeParagraph, Content: runs}
}

// parseInlineGroup is parseHyperlink/parseIns/parseDel without the
// link-specific bookkeeping — used to flatten a tracked-insertion's
// runs back into the surrounding paragraph.
func (p *docxParser) parseInlineGroup(dec *xml.Decoder, start xml.StartElement, runs *[]PMNode) error {
	for {
		tok, err := dec.Token()
		if err != nil {
			return err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			if t.Name.Local == "r" {
				if err := p.parseRun(dec, t, runs, nil); err != nil {
					return err
				}
			} else {
				if err := skipElement(dec, t); err != nil {
					return err
				}
			}
		case xml.EndElement:
			if t.Name.Local == start.Name.Local {
				return nil
			}
		}
	}
}

// parseParagraphProperties extracts the paragraph style id and (for
// list items) the numId / ilvl values out of <w:pPr>.
func (p *docxParser) parseParagraphProperties(dec *xml.Decoder, start xml.StartElement, pStyle, numID, ilvl *string) error {
	for {
		tok, err := dec.Token()
		if err != nil {
			return err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "pStyle":
				*pStyle = attrValue(t, "val")
				if err := skipElement(dec, t); err != nil {
					return err
				}
			case "numPr":
				if err := p.parseNumPr(dec, t, numID, ilvl); err != nil {
					return err
				}
			default:
				if err := skipElement(dec, t); err != nil {
					return err
				}
			}
		case xml.EndElement:
			if t.Name.Local == start.Name.Local {
				return nil
			}
		}
	}
}

// parseNumPr extracts numId and ilvl from <w:numPr>.
func (p *docxParser) parseNumPr(dec *xml.Decoder, start xml.StartElement, numID, ilvl *string) error {
	for {
		tok, err := dec.Token()
		if err != nil {
			return err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "numId":
				*numID = attrValue(t, "val")
			case "ilvl":
				*ilvl = attrValue(t, "val")
			}
			if err := skipElement(dec, t); err != nil {
				return err
			}
		case xml.EndElement:
			if t.Name.Local == start.Name.Local {
				return nil
			}
		}
	}
}

// parseRun reads one <w:r>, splits it into PMNode text/image runs,
// and applies the supplied extra marks (used by parseHyperlink to
// add a link mark on every nested run).
func (p *docxParser) parseRun(dec *xml.Decoder, start xml.StartElement, out *[]PMNode, extraMarks []PMMark) error {
	var marks []PMMark
	var collected []PMNode

	for {
		tok, err := dec.Token()
		if err != nil {
			return err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "rPr":
				m, err := p.parseRunProperties(dec, t)
				if err != nil {
					return err
				}
				marks = m
			case "t":
				txt, err := readElementText(dec, t)
				if err != nil {
					return err
				}
				if txt != "" {
					collected = append(collected, PMNode{Type: NodeTypeText, Text: txt})
				}
			case "tab":
				collected = append(collected, PMNode{Type: NodeTypeText, Text: "\t"})
				if err := skipElement(dec, t); err != nil {
					return err
				}
			case "br":
				// Line break — represent as a newline char inside the
				// surrounding text run. Loses the distinction between
				// soft break and page break, which is acceptable for v1.
				collected = append(collected, PMNode{Type: NodeTypeText, Text: "\n"})
				if err := skipElement(dec, t); err != nil {
					return err
				}
			case "drawing":
				img, err := p.parseDrawing(dec, t)
				if err != nil {
					return err
				}
				if img != nil {
					collected = append(collected, *img)
				}
			default:
				if err := skipElement(dec, t); err != nil {
					return err
				}
			}
		case xml.EndElement:
			if t.Name.Local == start.Name.Local {
				return p.flushRun(out, collected, marks, extraMarks)
			}
		}
	}
}

// flushRun applies the run's marks (plus any inherited extras from a
// hyperlink wrapper) to each text node in the run. Image nodes pass
// through without marks.
//
// When the run is wrapped by a <w:hyperlink>, drop any underline mark
// the run picked up from <w:u>: pm_to_docx.marksToTextFormat emits
// <w:u> alongside every link mark as a visual cue, so on round-trip we
// would otherwise re-import that derived underline as a real mark and
// the tree would gain a mark that wasn't in the source.
func (p *docxParser) flushRun(out *[]PMNode, collected []PMNode, marks, extras []PMMark) error {
	if hasMark(extras, MarkTypeLink) {
		marks = stripMark(marks, MarkTypeUnderline)
	}
	combined := mergeMarks(marks, extras)
	for _, c := range collected {
		if c.Type == NodeTypeText {
			if len(combined) > 0 {
				c.Marks = append([]PMMark(nil), combined...)
			}
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

// parseRunProperties extracts <w:rPr> bold/italic/underline marks.
// Bold and italic are toggle elements (presence == on, but a w:val of
// "false" / "0" / "off" inverts that); underline uses w:val for the
// style ("single"/"double"/"none").
func (p *docxParser) parseRunProperties(dec *xml.Decoder, start xml.StartElement) ([]PMMark, error) {
	var marks []PMMark
	for {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "b":
				if isOnToggle(t) {
					marks = append(marks, PMMark{Type: MarkTypeBold})
				}
			case "i":
				if isOnToggle(t) {
					marks = append(marks, PMMark{Type: MarkTypeItalic})
				}
			case "u":
				if v := attrValue(t, "val"); v != "" && v != "none" {
					marks = append(marks, PMMark{Type: MarkTypeUnderline})
				} else if v == "" {
					marks = append(marks, PMMark{Type: MarkTypeUnderline})
				}
			case "rStyle":
				// A character style. We pick up the "Hyperlink"
				// character style as an underline+link signal at the
				// surrounding paragraph level (parseHyperlink handles
				// link href). For other styles, drop silently — too
				// noisy to warn on.
			}
			if err := skipElement(dec, t); err != nil {
				return nil, err
			}
		case xml.EndElement:
			if t.Name.Local == start.Name.Local {
				return marks, nil
			}
		}
	}
}

// isOnToggle returns true for <w:b/>, <w:b w:val="true"/>,
// <w:b w:val="1"/>, etc., and false for explicit val="false"/"0"/"off".
func isOnToggle(start xml.StartElement) bool {
	v := attrValue(start, "val")
	if v == "" {
		return true
	}
	switch strings.ToLower(v) {
	case "false", "0", "off":
		return false
	}
	return true
}

// parseHyperlink wraps every contained run with a link mark whose
// href resolves via the shared rels map (or via the w:anchor
// attribute for in-document anchors).
func (p *docxParser) parseHyperlink(dec *xml.Decoder, start xml.StartElement, runs *[]PMNode) error {
	rid := attrValue(start, "id")
	anchor := attrValue(start, "anchor")
	href := ""
	if rid != "" {
		if rel, ok := p.rels[rid]; ok {
			href = rel.Target
		}
	}
	if href == "" && anchor != "" {
		href = "#" + anchor
	}

	var extra []PMMark
	if href != "" {
		extra = []PMMark{{Type: MarkTypeLink, Attrs: map[string]any{"href": href}}}
	}

	for {
		tok, err := dec.Token()
		if err != nil {
			return err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			if t.Name.Local == "r" {
				if err := p.parseRun(dec, t, runs, extra); err != nil {
					return err
				}
			} else {
				if err := skipElement(dec, t); err != nil {
					return err
				}
			}
		case xml.EndElement:
			if t.Name.Local == start.Name.Local {
				return nil
			}
		}
	}
}

// parseDrawing handles <w:drawing> (inline or anchor) and produces a
// PM image node. We extract the rId from the nested a:blip, look up
// the media filename via rels, and inline the image bytes from the
// docx zip as a self-contained data: URI. Embedding the bytes (rather
// than copying the in-zip path verbatim into src) keeps the PM tree
// round-trippable: PMJSONToDocx accepts only data: URIs because the
// emitter has no way to re-resolve in-zip paths from a tree that's
// been edited and re-serialized. Alt text comes from wp:docPr@descr.
//
// If the rels lookup or zip read fails, the image is dropped silently
// (no PM node emitted) — losing an unresolvable image is preferable
// to producing a tree that fails round-trip.
//
// Image dimensions are deliberately NOT preserved in v1: OOXML
// stores them as EMUs (1 inch = 914400 EMU) on the wp:extent
// element, but the editor schema doesn't have a place to put them
// and round-tripping fixed pixel sizes through PM is fragile.
// Sizing is a v2 concern.
func (p *docxParser) parseDrawing(dec *xml.Decoder, start xml.StartElement) (*PMNode, error) {
	var blipRid, alt, title string

	for {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "docPr":
				alt = attrValue(t, "descr")
				title = attrValue(t, "title")
			case "blip":
				if v := attrValue(t, "embed"); v != "" {
					blipRid = v
				}
			}
			// Drawings nest very deep; we walk forward on every
			// StartElement (no skip) so we see the inner blip
			// regardless of where it appears.
		case xml.EndElement:
			if t.Name.Local == start.Name.Local {
				if blipRid == "" {
					return nil, nil
				}
				rel, ok := p.rels[blipRid]
				if !ok {
					return nil, nil
				}
				src := p.resolveMediaSrc(rel.Target)
				if src == "" {
					return nil, nil
				}
				img := &PMNode{
					Type:  NodeTypeImage,
					Attrs: map[string]any{"src": src},
				}
				if alt != "" && alt != wordZeroDefaultImageLabel {
					img.Attrs["alt"] = alt
				}
				if title != "" && title != wordZeroDefaultImageLabel {
					img.Attrs["title"] = title
				}
				return img, nil
			}
		}
	}
}

// wordZeroDefaultImageLabel is the literal Chinese string ("image")
// that WordZero hard-codes into wp:docPr@descr / @title whenever an
// image's ImageConfig leaves AltText / Title empty (see
// createImageParagraph in image.go in WordZero v1.6.0). When we round-
// trip an image whose alt/title were absent in the source, WordZero
// re-emits the default — the parser drops it on import to keep the
// PMNode attribute set stable across passes.
const wordZeroDefaultImageLabel = "图片"

// resolveMediaSrc converts an in-zip media reference (the Target field
// from word/_rels/document.xml.rels — e.g. "media/image1.gif" or
// "../media/image1.gif") into a self-contained data: URI suitable for
// round-tripping back through PMJSONToDocx. Returns the data: URI on
// success, or empty string on failure (caller drops the image rather
// than emitting an unresolvable reference).
//
// rels Targets are relative to the location of the .rels file
// (word/_rels/document.xml.rels), so they're rooted at "word/".
// path.Clean(path.Join("word", target)) collapses any "../" prefixes
// the way Word writes them when the media is already inside word/.
func (p *docxParser) resolveMediaSrc(relTarget string) string {
	if p.zip == nil || relTarget == "" {
		return ""
	}
	cleaned := strings.TrimPrefix(path.Clean(path.Join("word", relTarget)), "/")
	for _, f := range p.zip.File {
		if f.Name != cleaned {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return ""
		}
		buf, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			return ""
		}
		return "data:" + mimeFromExt(path.Ext(cleaned)) + ";base64," +
			base64.StdEncoding.EncodeToString(buf)
	}
	return ""
}

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

// parseTable reads <w:tbl> into a PM table node.
func (p *docxParser) parseTable(dec *xml.Decoder, start xml.StartElement) (*PMNode, error) {
	tbl := &PMNode{Type: NodeTypeTable}
	for {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "tr":
				row, err := p.parseTableRow(dec, t)
				if err != nil {
					return nil, err
				}
				if row != nil {
					tbl.Content = append(tbl.Content, *row)
				}
			default:
				if err := skipElement(dec, t); err != nil {
					return nil, err
				}
			}
		case xml.EndElement:
			if t.Name.Local == start.Name.Local {
				padTableRowsToMaxWidth(tbl)
				return tbl, nil
			}
		}
	}
}

// padTableRowsToMaxWidth normalizes a parsed table so every row has
// the same cell count, padding shorter rows with empty cells. The
// emitter (pm_to_docx.emitTable) already creates a uniform-width
// WordZero table by computing max(cols) across rows, so on round-trip
// any short row gains empty cells regardless of what we do here. We
// pad on import so pass-1 and pass-3 trees match structurally.
func padTableRowsToMaxWidth(tbl *PMNode) {
	maxCols := 0
	for _, row := range tbl.Content {
		if c := len(row.Content); c > maxCols {
			maxCols = c
		}
	}
	for i := range tbl.Content {
		row := &tbl.Content[i]
		for len(row.Content) < maxCols {
			row.Content = append(row.Content, PMNode{
				Type: NodeTypeTableCell,
				Content: []PMNode{
					{Type: NodeTypeParagraph},
				},
			})
		}
	}
}

func (p *docxParser) parseTableRow(dec *xml.Decoder, start xml.StartElement) (*PMNode, error) {
	row := &PMNode{Type: NodeTypeTableRow}
	for {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "tc":
				cell, err := p.parseTableCell(dec, t)
				if err != nil {
					return nil, err
				}
				if cell != nil {
					row.Content = append(row.Content, *cell)
				}
			default:
				if err := skipElement(dec, t); err != nil {
					return nil, err
				}
			}
		case xml.EndElement:
			if t.Name.Local == start.Name.Local {
				return row, nil
			}
		}
	}
}

func (p *docxParser) parseTableCell(dec *xml.Decoder, start xml.StartElement) (*PMNode, error) {
	cell := &PMNode{Type: NodeTypeTableCell}
	for {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "p":
				para, err := p.parseParagraph(dec, t)
				if err != nil {
					return nil, err
				}
				if para != nil {
					// Cell paragraphs never participate in list
					// grouping, so strip any list metadata that
					// snuck in (it would confuse the post-pass).
					if para.Attrs != nil {
						delete(para.Attrs, "_listNumId")
						delete(para.Attrs, "_listLevel")
						delete(para.Attrs, "_listFmt")
						if len(para.Attrs) == 0 {
							para.Attrs = nil
						}
					}
					cell.Content = append(cell.Content, liftInlineImages(*para)...)
				}
			case "tbl":
				nested, err := p.parseTable(dec, t)
				if err != nil {
					return nil, err
				}
				if nested != nil {
					cell.Content = append(cell.Content, *nested)
				}
			default:
				if err := skipElement(dec, t); err != nil {
					return nil, err
				}
			}
		case xml.EndElement:
			if t.Name.Local == start.Name.Local {
				cell.Content = collapseLeadingEmptyParagraphs(cell.Content)
				return cell, nil
			}
		}
	}
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

// parseSdt unwraps <w:sdt> by recursively descending into its
// contents and emitting the inner block-level nodes as if the sdt
// wasn't there.
func (p *docxParser) parseSdt(dec *xml.Decoder, start xml.StartElement) (*PMNode, error) {
	for {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			if t.Name.Local == "sdtContent" {
				// Walk the sdtContent and return its first
				// block-level child. SDTs commonly wrap a single
				// paragraph; multi-paragraph SDTs lose all but the
				// first (acceptable for v1, signaled by the warning).
				return p.parseSdtContent(dec, t)
			}
			if err := skipElement(dec, t); err != nil {
				return nil, err
			}
		case xml.EndElement:
			if t.Name.Local == start.Name.Local {
				return nil, nil
			}
		}
	}
}

func (p *docxParser) parseSdtContent(dec *xml.Decoder, start xml.StartElement) (*PMNode, error) {
	for {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			node, err := p.parseBodyChild(dec, t)
			if err != nil {
				return nil, err
			}
			if node != nil {
				// Drain the rest of sdtContent without producing more
				// nodes; first body-level child wins.
				if err := skipUntilEnd(dec, start.Name.Local); err != nil {
					return nil, err
				}
				return node, nil
			}
		case xml.EndElement:
			if t.Name.Local == start.Name.Local {
				return nil, nil
			}
		}
	}
}

// readElementText reads CharData inside a <w:t> (or similar) element
// until its closing tag.
func readElementText(dec *xml.Decoder, start xml.StartElement) (string, error) {
	var sb strings.Builder
	for {
		tok, err := dec.Token()
		if err != nil {
			return "", err
		}
		switch t := tok.(type) {
		case xml.CharData:
			sb.Write(t)
		case xml.EndElement:
			if t.Name.Local == start.Name.Local {
				return sb.String(), nil
			}
		case xml.StartElement:
			// shouldn't happen inside <w:t>, but just in case
			if err := skipElement(dec, t); err != nil {
				return "", err
			}
		}
	}
}

// skipElement consumes tokens until the matching EndElement of the
// supplied StartElement is seen. Handles arbitrary nesting depth.
func skipElement(dec *xml.Decoder, start xml.StartElement) error {
	depth := 1
	for depth > 0 {
		tok, err := dec.Token()
		if err != nil {
			return err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			if t.Name.Local == start.Name.Local {
				depth++
			}
		case xml.EndElement:
			if t.Name.Local == start.Name.Local {
				depth--
			}
		}
	}
	return nil
}

// skipUntilEnd consumes tokens until the named element closes —
// useful when a function takes over after partially consuming a
// container.
func skipUntilEnd(dec *xml.Decoder, name string) error {
	for {
		tok, err := dec.Token()
		if err != nil {
			return err
		}
		if t, ok := tok.(xml.EndElement); ok && t.Name.Local == name {
			return nil
		}
	}
}

// attrValue looks up a single attribute by local name on the
// start element. Returns "" if absent.
func attrValue(start xml.StartElement, name string) string {
	for _, a := range start.Attr {
		if a.Name.Local == name {
			return a.Value
		}
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
func groupListParagraphs(blocks []PMNode) []PMNode {
	var out []PMNode
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
			out = append(out, buildListTree(run))
			continue
		}
		out = append(out, blocks[i])
		i++
	}
	return out
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
