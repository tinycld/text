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
	"sync"

	"github.com/ZeroHawkeye/wordZero/pkg/document"
)

// numberingMu serializes WordZero document emission across concurrent
// callers. WordZero's document package keeps a process-global
// NumberingManager singleton that allocates <w:numId> values; two
// goroutines flushing different rooms at the same time race for that
// counter and can interleave numbering definitions across documents,
// producing malformed list output. The emit path is short and runs off
// the SaveCoordinator's worker pool, so the contention cost of a single
// package-level mutex is acceptable v1; revisit if we replace WordZero.
var numberingMu sync.Mutex

// Silence WordZero's INFO-level chatter — every table create / cell
// clear / cell add prints to stdout by default. Errors still flow
// through err returns. We never want this in tests or production.
func init() {
	document.SetGlobalLevel(document.LogLevelSilent)
}

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

// PMJSONToDocx translates a ProseMirror JSON tree into .docx bytes.
// Returns an error if the JSON is malformed or contains node/mark
// types outside the supported set.
//
// Soft degradations (e.g. an oversized image dropped) are silently
// discarded by this wrapper. Callers that want to surface them to the
// user should use PMJSONToDocxWithWarnings instead.
//
// Implementation strategy: drive WordZero for the bulk of the
// document (paragraphs, headings, lists, tables, blockquote-styled
// paragraphs, inline images). Hyperlinks are emitted as marker text
// runs, then post-processed: the marker tokens in word/document.xml
// are rewritten as <w:hyperlink r:id=…> wrappers and matching
// Relationship rows are appended to word/_rels/document.xml.rels.
func PMJSONToDocx(pmJSON []byte) ([]byte, error) {
	bs, _, err := PMJSONToDocxWithWarnings(pmJSON)
	return bs, err
}

// PMJSONToDocxWithWarnings is the warnings-aware variant of
// PMJSONToDocx. The returned slice contains every soft-degradation
// signal the emitter raised (e.g. an oversized image was dropped) —
// hard errors still come back via the error return.
func PMJSONToDocxWithWarnings(pmJSON []byte) ([]byte, []Warning, error) {
	var root PMNode
	if err := json.Unmarshal(pmJSON, &root); err != nil {
		return nil, nil, fmt.Errorf("translate: unmarshal pmJSON: %w", err)
	}
	if root.Type != NodeTypeDoc {
		return nil, nil, fmt.Errorf("translate: pmJSON root must be type=doc, got %q", root.Type)
	}

	// Hold numberingMu across the entire emit + serialize so every call
	// that might touch WordZero's global NumberingManager (AddBulletList /
	// AddNumberedList allocations, plus ToBytes which materializes
	// numbering.xml from that shared state) is serialized.
	numberingMu.Lock()
	defer numberingMu.Unlock()

	em := newEmitter()
	for _, child := range root.Content {
		if err := em.emitBlock(child, 0, ""); err != nil {
			return nil, nil, err
		}
	}

	bs, err := em.doc.ToBytes()
	if err != nil {
		return nil, nil, fmt.Errorf("translate: serialize docx: %w", err)
	}

	if len(em.linkRels) > 0 {
		bs, err = postProcessLinks(bs, em.linkRels)
		if err != nil {
			return nil, nil, err
		}
	}
	if len(em.pageBreaks) > 0 || len(em.commentSpans) > 0 || len(em.footnotes) > 0 || len(em.endnotes) > 0 {
		bs, err = postProcessRichXML(bs, em)
		if err != nil {
			return nil, nil, err
		}
	}
	return bs, em.warnings, nil
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
	// lastOrderedNumIDAtLevel0 is the most recent level-0 ordered-list
	// numId we've emitted in this document, surviving across sibling
	// lists. When a later orderedList carries start > 1, we reuse this
	// numId so OOXML's natural numbering continuation produces the
	// expected resumed numbers (Word's behavior when an ordered list is
	// visually interrupted by a nested bulleted list and then resumed).
	lastOrderedNumIDAtLevel0 string

	// Page break / comment / footnote / endnote post-process state.
	// Each feature uses the same marker-token strategy that links use:
	// we plant uniquely-recognizable strings inside the WordZero output,
	// then rewrite them in postProcess* passes once WordZero has
	// finished serializing the body. Marker IDs are independent monotonic
	// counters per kind.
	pageBreaks     []pageBreakMarker
	pageBreakSeq   int
	commentSpans   []commentSpan
	commentSpanSeq int // monotonic uniqueness counter for marker tokens
	commentIDSeq   int // OOXML w:id allocator for synthesized ids
	// Authored comments accumulated during emission, keyed by the
	// runtime comment id we assigned. Each entry feeds one <w:comment>
	// in word/comments.xml on flush.
	commentBodies map[string]commentBody
	footnotes     []footnoteEntry
	endnotes      []footnoteEntry
	footnoteSeq   int
	endnoteSeq    int

	// warnings accumulates soft-degradation signals raised during
	// emission (currently: oversized / unsupported-type images dropped).
	// Surfaced by PMJSONToDocxWithWarnings; the legacy PMJSONToDocx
	// signature drops them silently.
	warnings   []Warning
	warningSet map[WarningCode]struct{}
}

// pageBreakMarker tracks a single page-break PM node that emit time
// recorded; postProcessPageBreaks rewrites the marker text run into
// <w:br w:type="page"/> inside the surrounding paragraph.
type pageBreakMarker struct {
	Marker string
}

// commentSpan tracks one PM comment mark span as a (open marker, close
// marker, id) triple. Two PM runs are wrapped at emit time:
//   - {{__pmcm:N:open}} just before the first masked text
//   - {{__pmcm:N:close}} just after the last masked text
//
// Post-process rewrites both into <w:commentRangeStart/> and
// <w:commentRangeEnd/> + <w:commentReference w:id="N"/>.
type commentSpan struct {
	OpenMarker  string
	CloseMarker string
	ID          string
}

// commentBody is what we'll serialize into word/comments.xml on flush —
// one entry per comment, populated from the PM mark attrs.
type commentBody struct {
	ID     string
	Author string
	Text   string
	Date   string
}

// footnoteEntry holds one footnote (or endnote) body we accumulated
// during emission. ID is the OOXML id (1-based, with 1+ reserved for
// user notes since Word seeds 0 = separator). MarkerText is the inline
// token we substitute into <w:footnoteReference w:id="ID"/> later.
type footnoteEntry struct {
	ID     string
	Text   string
	Marker string
}

// addWarning records a unique soft-degradation signal. Same dedupe
// behaviour as the docxParser-side addWarning: one entry per code,
// since the user only cares "did images get dropped?", not "how many."
func (em *emitter) addWarning(code WarningCode, detail string) {
	if em.warningSet == nil {
		em.warningSet = make(map[WarningCode]struct{})
	}
	if _, seen := em.warningSet[code]; seen {
		return
	}
	em.warningSet[code] = struct{}{}
	em.warnings = append(em.warnings, Warning{Code: code, Detail: detail})
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

	// Resumed ordered list: if PM has marked this list with start > 1
	// AND we have a prior level-0 ordered-list numId available, seed
	// the scope with it so all items in this list reuse that same numId.
	// In OOXML, sharing a numId across visually separate lists is how
	// Word implements numbering continuation past nested interruptions.
	if listLevel == 0 && listType == NodeTypeOrderedList && em.lastOrderedNumIDAtLevel0 != "" {
		if startVal, ok := node.Attrs["start"]; ok && asInt(startVal) > 1 {
			em.recordListNumID(0, em.lastOrderedNumIDAtLevel0)
		}
	}

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

	// After emitting a level-0 ordered list, remember its numId so a
	// subsequent resumed list can reuse it.
	if listLevel == 0 && listType == NodeTypeOrderedList && listLevel < len(em.listScope) {
		if numID := em.listScope[0]; numID != "" {
			em.lastOrderedNumIDAtLevel0 = numID
		}
	}
	return nil
}

// asInt coerces a JSON-decoded number (float64) or int to int. Returns
// 0 for any other type.
func asInt(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	}
	return 0
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
//
// Column widths: PM tableCell.colwidth (px, one entry per spanned
// column) is converted back to dxa and seeded into the table's grid
// + per-cell <w:tcW>. We compute the per-column dxa array by walking
// the first row and unrolling each cell's colwidth across colspan
// slots. Cells with colspan > 1 are then merged with
// MergeCellsHorizontal so OOXML re-derives the same grid layout.
func (em *emitter) emitTable(node PMNode) error {
	rows := len(node.Content)
	if rows == 0 {
		return nil
	}
	cols, colDxa := tableGeometry(node)
	if cols == 0 {
		return nil
	}
	cfg := &document.TableConfig{Rows: rows, Cols: cols}
	if len(colDxa) == cols {
		cfg.ColWidths = colDxa
	}
	tbl, err := em.doc.AddTable(cfg)
	if err != nil {
		return fmt.Errorf("translate: create table: %w", err)
	}

	// Two-pass emit so vertical and horizontal merges don't interfere.
	//
	//   Pass A — emit content + collect merge plans. Walks rows and
	//     places each PM cell at its physical column index. Tracks
	//     vertically-covered columns via vCover[] so PM's "missing"
	//     cells under rowspan>1 starts don't shift the cursor. Records
	//     each colspan>1 cell as a deferred horizontal-merge, and each
	//     rowspan>1 cell as a deferred vertical-merge.
	//
	//   Pass B — apply all vertical merges first. WordZero's
	//     MergeCellsVertical doesn't change row cell counts (only
	//     stamps <w:vMerge> on the spanned-over cells), so it's safe
	//     to run before horizontal merges per-row.
	//
	//   Pass C — apply horizontal merges per-row, right-to-left.
	//     MergeCellsHorizontal splices cells out, so iterating in
	//     reverse keeps earlier merge indices valid.
	type hMerge struct{ row, start, end int }
	type vMerge struct{ startRow, endRow, col int }
	var hMerges []hMerge
	var vMerges []vMerge
	// vCover[c] = remaining rows after the current one that are still
	// covered by an earlier cell's rowspan at column c. Decremented at
	// the end of each row.
	vCover := make([]int, cols)
	for r, row := range node.Content {
		if row.Type != NodeTypeTableRow {
			continue
		}
		col := 0
		for _, cell := range row.Content {
			if cell.Type != NodeTypeTableCell {
				continue
			}
			// Skip columns that are vertically covered by a prior
			// rowspan>1 cell. PM omits the placeholder cells under a
			// rowspan, so we have to advance the cursor without
			// emitting anything.
			for col < cols && vCover[col] > 0 {
				col++
			}
			if col >= cols {
				break
			}
			span := cellColspan(cell)
			rspan := cellRowspan(cell)
			if err := em.emitTableCell(tbl, r, col, cell); err != nil {
				return err
			}
			if span > 1 {
				end := col + span - 1
				if end >= cols {
					end = cols - 1
				}
				hMerges = append(hMerges, hMerge{r, col, end})
			}
			if rspan > 1 {
				endRow := r + rspan - 1
				if endRow >= rows {
					endRow = rows - 1
				}
				if endRow > r {
					vMerges = append(vMerges, vMerge{r, endRow, col})
					// Record the rowspan coverage for every spanned
					// column so subsequent rows skip them.
					for c := col; c < col+span && c < cols; c++ {
						vCover[c] = (endRow - r) + 1
					}
				}
			}
			col += span
		}
		// End-of-row: decrement coverage so the next row sees one
		// fewer row of cover.
		for c := range vCover {
			if vCover[c] > 0 {
				vCover[c]--
			}
		}
	}

	// Pass B — vertical merges first (no cell-count change).
	for _, v := range vMerges {
		if err := tbl.MergeCellsVertical(v.startRow, v.endRow, v.col); err != nil {
			return fmt.Errorf("translate: merge cells vertical [%d..%d],%d: %w", v.startRow, v.endRow, v.col, err)
		}
	}

	// Pass C — horizontal merges per row, right-to-left.
	hByRow := make(map[int][]hMerge, len(hMerges))
	for _, m := range hMerges {
		hByRow[m.row] = append(hByRow[m.row], m)
	}
	for r := range node.Content {
		rowMerges := hByRow[r]
		for i := len(rowMerges) - 1; i >= 0; i-- {
			m := rowMerges[i]
			// Sum the spanned dxa widths so the surviving cell's <w:tcW>
			// reflects the full merged width. Without this, WordZero
			// keeps the start cell's own (unmerged) width and re-import
			// would split the visible width across gridSpan, halving
			// each spanned column's recorded size every round-trip.
			merged := 0
			if len(colDxa) == cols {
				for c := m.start; c <= m.end && c < len(colDxa); c++ {
					merged += colDxa[c]
				}
			}
			if err := tbl.MergeCellsHorizontal(m.row, m.start, m.end); err != nil {
				return fmt.Errorf("translate: merge cells %d,[%d..%d]: %w", m.row, m.start, m.end, err)
			}
			if merged > 0 {
				if c, err := tbl.GetCell(m.row, m.start); err == nil {
					if c.Properties == nil {
						c.Properties = &document.TableCellProperties{}
					}
					if c.Properties.TableCellW == nil {
						c.Properties.TableCellW = &document.TableCellW{Type: "dxa"}
					}
					c.Properties.TableCellW.W = strconv.Itoa(merged)
					c.Properties.TableCellW.Type = "dxa"
				}
			}
		}
	}
	return nil
}

// tableGeometry counts physical columns and computes a per-column dxa
// width array, both derived from the first row that carries colwidth
// data. Falls back to (max cell count across rows, no widths) when no
// row carries widths, which yields a default auto-sized table.
func tableGeometry(table PMNode) (int, []int) {
	maxCells := 0
	for _, row := range table.Content {
		if row.Type == NodeTypeTableRow {
			if c := len(row.Content); c > maxCells {
				maxCells = c
			}
		}
	}
	// Look for the first row that has colwidth on every cell — that's
	// the row we trust to define the physical grid. The first row of
	// a Word table almost always carries widths even if downstream
	// rows have merged cells; that's the row we want.
	for _, row := range table.Content {
		if row.Type != NodeTypeTableRow {
			continue
		}
		widths := []int{}
		ok := true
		totalCols := 0
		for _, cell := range row.Content {
			if cell.Type != NodeTypeTableCell {
				continue
			}
			span := cellColspan(cell)
			cw, hasCW := cellColwidthPx(cell)
			if !hasCW || len(cw) == 0 {
				ok = false
				break
			}
			// colwidth is per-spanned-col in PM. Translate each entry
			// back to dxa and place it into the column grid.
			for i := 0; i < span; i++ {
				if i < len(cw) {
					widths = append(widths, pxToDxa(cw[i]))
				} else {
					// Fewer colwidth entries than span — duplicate the
					// last one across the remainder.
					widths = append(widths, pxToDxa(cw[len(cw)-1]))
				}
			}
			totalCols += span
		}
		if ok && totalCols > 0 {
			if totalCols > maxCells {
				maxCells = totalCols
			}
			return totalCols, widths
		}
	}
	return maxCells, nil
}

// cellColspan reads colspan off a tableCell, defaulting to 1.
func cellColspan(cell PMNode) int {
	if cell.Attrs == nil {
		return 1
	}
	if v, ok := cell.Attrs["colspan"]; ok {
		if n := asInt(v); n > 0 {
			return n
		}
	}
	return 1
}

// cellRowspan reads rowspan off a tableCell, defaulting to 1. Parallel
// to cellColspan — rowspan>1 means the cell vertically spans the next
// (rowspan-1) rows, which gets emitted as <w:vMerge> via
// MergeCellsVertical.
func cellRowspan(cell PMNode) int {
	if cell.Attrs == nil {
		return 1
	}
	if v, ok := cell.Attrs["rowspan"]; ok {
		if n := asInt(v); n > 0 {
			return n
		}
	}
	return 1
}

// cellColwidthPx reads colwidth off a tableCell as an int slice (px).
// Returns (nil, false) if the attr is missing or shaped unexpectedly.
func cellColwidthPx(cell PMNode) ([]int, bool) {
	if cell.Attrs == nil {
		return nil, false
	}
	raw, ok := cell.Attrs["colwidth"]
	if !ok {
		return nil, false
	}
	arr, ok := raw.([]any)
	if !ok {
		// Already an []int (when called from internal Go code rather
		// than after JSON unmarshal).
		if a, ok2 := raw.([]int); ok2 {
			return a, true
		}
		return nil, false
	}
	out := make([]int, 0, len(arr))
	for _, v := range arr {
		out = append(out, asInt(v))
	}
	return out, true
}

// pxToDxa is the inverse of dxaToPx (1 dxa ≈ 1/15 px at 96 dpi).
func pxToDxa(px int) int {
	if px <= 0 {
		return 0
	}
	return px * 15
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
	// Borders attached to the cell flow through to <w:tcBorders>. We do
	// this after the paragraph emission because GetCell expects the
	// cell to exist in the underlying table model already.
	if borders := tcBordersFromAttr(cell.Attrs); borders != nil {
		c, err := tbl.GetCell(row, col)
		if err == nil && c != nil {
			if c.Properties == nil {
				c.Properties = &document.TableCellProperties{}
			}
			c.Properties.TcBorders = borders
		}
	}
	return nil
}

// emitImageBlock embeds a block-level image. v1 supports data: URIs
// and embedded images via AddImageFromData. Network URLs are
// rejected for now (caller should pre-fetch); see report.
//
// PM attrs map to WordZero's ImageConfig:
//   - wrap="left"  -> Position: floatLeft,  WrapText: square
//   - wrap="right" -> Position: floatRight, WrapText: square
//   - wrap absent / "none" -> default inline drawing
//
// We choose `square` (not `tight`) for the wrap mode because square
// requires no wrap polygon and renders identically for rectangular
// images. tight requires a per-image polygon we don't store.
func (em *emitter) emitImageBlock(node PMNode) error {
	src, _ := node.Attrs["src"].(string)
	if src == "" {
		return fmt.Errorf("translate: image node missing src attr")
	}
	data, format, skip, err := em.decodeAndValidateImage(src)
	if err != nil {
		return err
	}
	if skip {
		return nil
	}
	cfg := &document.ImageConfig{}
	if alt, ok := node.Attrs["alt"].(string); ok && alt != "" {
		cfg.AltText = alt
	}
	if title, ok := node.Attrs["title"].(string); ok && title != "" {
		cfg.Title = title
	}
	applyImageWrap(cfg, node.Attrs)
	_, err = em.doc.AddImageFromData(data, deriveImageName(src, format), format, 0, 0, cfg)
	if err != nil {
		return fmt.Errorf("translate: add image: %w", err)
	}
	return nil
}

// decodeAndValidateImage runs the byte / MIME validation pipeline that
// sits between the client-supplied data: URI and WordZero's
// AddImageFromData. Returns (data, format, skip=true) when the image
// should be silently dropped with a warning attached — used for
// payloads that exceed MaxImageBytes or carry an unsupported media
// type (image/svg+xml etc.). A non-nil error means a malformed URI
// the caller should propagate.
//
// Note: validation is by declared MIME (data: header), not by sniffing
// magic bytes. A client that lies about its content type can still get
// the bytes embedded as long as the size cap is respected; WordZero
// then surfaces the format mismatch to Word at open time. We accept
// that risk in v1 since the only ingress is the editor's image-insert
// flow, which constructs the header from a typed File.
func (em *emitter) decodeAndValidateImage(src string) ([]byte, document.ImageFormat, bool, error) {
	if strings.HasPrefix(src, "data:") {
		mediaType, _ := parseDataURIHeader(src)
		if mediaType != "" && !allowedImageMediaTypes[strings.ToLower(mediaType)] {
			em.addWarning(WarningUnsupportedImageType,
				fmt.Sprintf("image with media type %q dropped", mediaType))
			return nil, "", true, nil
		}
	}
	data, format, err := decodeImageSrc(src)
	if err != nil {
		return nil, "", false, err
	}
	if len(data) > MaxImageBytes {
		em.addWarning(WarningImageTooLarge,
			fmt.Sprintf("image of %d bytes exceeded %d-byte cap and was dropped", len(data), MaxImageBytes))
		return nil, "", true, nil
	}
	return data, format, false, nil
}

// parseDataURIHeader returns the media type from a data: URI without
// decoding the body. Returns ("", false) if the URI is malformed.
func parseDataURIHeader(src string) (string, bool) {
	if !strings.HasPrefix(src, "data:") {
		return "", false
	}
	comma := strings.IndexByte(src, ',')
	if comma < 0 {
		return "", false
	}
	header := src[len("data:"):comma]
	return strings.SplitN(header, ";", 2)[0], true
}

// applyImageWrap reads the image's `wrap` attribute and configures
// the WordZero ImageConfig to produce the matching anchor drawing.
// Unknown values are treated as no-op (default inline).
func applyImageWrap(cfg *document.ImageConfig, attrs map[string]any) {
	wrap, _ := attrs["wrap"].(string)
	switch wrap {
	case "left":
		cfg.Position = document.ImagePositionFloatLeft
		cfg.WrapText = document.ImageWrapSquare
	case "right":
		cfg.Position = document.ImagePositionFloatRight
		cfg.WrapText = document.ImageWrapSquare
	}
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
// added via AddImageFromData and (when floated) transplanted onto
// the host paragraph so the resulting <w:p> contains both image and
// text — this is what lets the importer reconstruct the original
// "image inline with text" PM tree on round-trip.
func (em *emitter) emitInlineRuns(p *document.Paragraph, runs []PMNode) error {
	for _, r := range runs {
		switch r.Type {
		case NodeTypeText:
			if err := em.emitTextRun(p, r); err != nil {
				return err
			}
		case NodeTypeImage:
			if err := em.emitInlineImage(p, r); err != nil {
				return err
			}
		case NodeTypePageBreak:
			em.emitPageBreak(p)
		case NodeTypeFootnoteReference:
			em.emitNoteReference(p, r, true)
		case NodeTypeEndnoteReference:
			em.emitNoteReference(p, r, false)
		default:
			return fmt.Errorf("translate: unsupported inline node %q", r.Type)
		}
	}
	return nil
}

// emitPageBreak plants a marker text run inside the paragraph that the
// post-process pass will rewrite into <w:br w:type="page"/>. Doing the
// rewrite at the XML layer (rather than mutating WordZero's Run struct)
// avoids tying us to private fields of the dependency.
func (em *emitter) emitPageBreak(p *document.Paragraph) {
	em.pageBreakSeq++
	marker := pageBreakToken(em.pageBreakSeq)
	em.pageBreaks = append(em.pageBreaks, pageBreakMarker{Marker: marker})
	p.AddFormattedText(marker, &document.TextFormat{})
}

// emitNoteReference plants a marker text run and queues a footnote /
// endnote body for the post-process pass. Each marker rewrites into
// <w:footnoteReference w:id="N"/> (or endnoteReference); the bodies
// land in word/footnotes.xml / word/endnotes.xml.
//
// We pick monotonic IDs starting at 1 because Word reserves id 0 for
// the separator / continuation separator notes and rejects ids that
// collide.
func (em *emitter) emitNoteReference(p *document.Paragraph, node PMNode, footnote bool) {
	text, _ := node.Attrs["text"].(string)
	var marker, id string
	if footnote {
		em.footnoteSeq++
		id = strconv.Itoa(em.footnoteSeq)
		marker = footnoteToken(em.footnoteSeq)
		em.footnotes = append(em.footnotes, footnoteEntry{ID: id, Text: text, Marker: marker})
	} else {
		em.endnoteSeq++
		id = strconv.Itoa(em.endnoteSeq)
		marker = endnoteToken(em.endnoteSeq)
		em.endnotes = append(em.endnotes, footnoteEntry{ID: id, Text: text, Marker: marker})
	}
	p.AddFormattedText(marker, &document.TextFormat{})
}

func pageBreakToken(n int) string { return "{{__pmpb:" + strconv.Itoa(n) + "}}" }
func footnoteToken(n int) string  { return "{{__pmfn:" + strconv.Itoa(n) + "}}" }
func endnoteToken(n int) string   { return "{{__pmen:" + strconv.Itoa(n) + "}}" }
func commentOpenToken(n int) string {
	return "{{__pmcm:" + strconv.Itoa(n) + ":open}}"
}
func commentCloseToken(n int) string {
	return "{{__pmcm:" + strconv.Itoa(n) + ":close}}"
}

// queueCommentMarks builds the open/close marker pair for every
// MarkTypeComment mark on a run AND records the comment body so the
// post-process pass can write word/comments.xml. Returns the span set
// in mark order so the caller can flank the run's text in nesting
// order.
//
// Each PM mark produces a fresh range span (a fresh open/close marker
// pair in document.xml). The OOXML comment id is shared across all
// spans that carry the same input PM id — that way a single logical
// comment whose text the user has split across multiple PM runs still
// points to one entry in word/comments.xml. When the PM mark has no
// id attr we synthesize a monotonic one keyed at em.commentSeq.
func (em *emitter) queueCommentMarks(marks []PMMark) []commentSpan {
	if len(marks) == 0 {
		return nil
	}
	var spans []commentSpan
	if em.commentBodies == nil {
		em.commentBodies = map[string]commentBody{}
	}
	for _, m := range marks {
		if m.Type != MarkTypeComment {
			continue
		}
		id, _ := m.Attrs["id"].(string)
		if id == "" {
			em.commentIDSeq++
			id = strconv.Itoa(em.commentIDSeq)
		}
		em.commentSpanSeq++
		span := commentSpan{
			OpenMarker:  commentOpenToken(em.commentSpanSeq),
			CloseMarker: commentCloseToken(em.commentSpanSeq),
			ID:          id,
		}
		if _, exists := em.commentBodies[id]; !exists {
			body := commentBody{ID: id}
			body.Author, _ = m.Attrs["author"].(string)
			body.Text, _ = m.Attrs["text"].(string)
			body.Date, _ = m.Attrs["date"].(string)
			em.commentBodies[id] = body
		}
		em.commentSpans = append(em.commentSpans, span)
		spans = append(spans, span)
	}
	return spans
}

// emitTextRun is the workhorse: convert PM marks into a WordZero
// TextFormat and append the run. If the node carries a link mark,
// we wrap the text in linkOpen/linkClose marker tokens — those get
// rewritten into <w:hyperlink r:id=…> in postProcessLinks. Comment
// marks are similarly wrapped in {{__pmcm:…}} tokens for the post-
// process pass to rewrite into <w:commentRange*> markers + queue the
// comment body for word/comments.xml.
func (em *emitter) emitTextRun(p *document.Paragraph, node PMNode) error {
	if node.Text == "" {
		return nil
	}
	href, hasLink := linkHref(node.Marks)
	fmt := marksToTextFormat(node.Marks)
	empty := &document.TextFormat{}

	commentSpans := em.queueCommentMarks(node.Marks)
	for _, span := range commentSpans {
		p.AddFormattedText(span.OpenMarker, empty)
	}

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
		p.AddFormattedText(open, empty)
		p.AddFormattedText(node.Text, fmt)
		p.AddFormattedText(closeTok, empty)
	} else {
		p.AddFormattedText(node.Text, fmt)
	}

	// Close spans in LIFO order so nested comments produce well-
	// balanced (innermost-first) commentRangeEnd markers.
	for i := len(commentSpans) - 1; i >= 0; i-- {
		p.AddFormattedText(commentSpans[i].CloseMarker, empty)
	}
	return nil
}

// emitInlineImage adds an image that appeared inside a paragraph's
// inline runs. WordZero's AddImageFromData always appends a NEW
// <w:p> to Body.Elements containing the drawing — that's the wrong
// shape for round-trip when the PM tree placed the image as a child
// of an existing paragraph (typical for wrap=left/right). To fix:
// we call AddImageFromData, then transplant its drawing run onto
// the host paragraph and drop the orphan paragraph from the body.
//
// Plain unwrapped inline images (no wrap attr) get the same
// treatment — keeping them inside their host paragraph matches what
// the parser produces and keeps the lifting/round-trip rules
// consistent. (At parse time, only unwrapped images get lifted into
// their own block; wrapped ones stay inline.)
func (em *emitter) emitInlineImage(p *document.Paragraph, node PMNode) error {
	bodyLenBefore := len(em.doc.Body.Elements)
	if err := em.emitImageBlock(node); err != nil {
		return err
	}
	bodyLenAfter := len(em.doc.Body.Elements)
	// When validation dropped the image (oversized / unsupported type),
	// emitImageBlock returns nil without adding a body element. The
	// warning has already been recorded; the host paragraph just keeps
	// its remaining inline runs.
	if bodyLenAfter == bodyLenBefore {
		return nil
	}
	// AddImageFromData appends exactly one Paragraph element on success.
	if bodyLenAfter != bodyLenBefore+1 {
		return fmt.Errorf("translate: emitInlineImage expected 1 new body element, got %d", bodyLenAfter-bodyLenBefore)
	}
	added, ok := em.doc.Body.Elements[bodyLenAfter-1].(*document.Paragraph)
	if !ok || added == nil || len(added.Runs) == 0 || added.Runs[0].Drawing == nil {
		return fmt.Errorf("translate: emitInlineImage could not locate WordZero-generated drawing")
	}
	// Splice the drawing run onto the host paragraph and drop the
	// orphan from the body.
	p.Runs = append(p.Runs, added.Runs[0])
	em.doc.Body.Elements = em.doc.Body.Elements[:bodyLenAfter-1]
	return nil
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
	// TextStyle.color is applied first so a Link mark (which forces the
	// accent color) wins for hyperlinks, matching Word's behavior of
	// hyperlinks always being the accent blue regardless of any
	// explicit color set on the same run.
	for _, m := range marks {
		if m.Type != MarkTypeTextStyle {
			continue
		}
		if c, ok := m.Attrs["color"].(string); ok && c != "" {
			fmt.FontColor = strings.TrimPrefix(c, "#")
			any = true
		}
	}
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
// preserving the original file ordering and storage method. Any keys
// in parts that didn't exist in the original (e.g. word/comments.xml
// that we just synthesized) are appended at the end with Deflate.
func rezipParts(orig *zip.Reader, parts map[string][]byte) ([]byte, error) {
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	seen := map[string]bool{}
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
		seen[f.Name] = true
	}
	for name, data := range parts {
		if seen[name] {
			continue
		}
		out, err := w.Create(name)
		if err != nil {
			return nil, err
		}
		if _, err := out.Write(data); err != nil {
			return nil, err
		}
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
