package text

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"strings"
	"sync"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"
	_ "golang.org/x/image/webp"

	"tinycld.org/core/previewqueue"
	"tinycld.org/core/realtime"
	"tinycld.org/core/thumbnails/textpreview"
	"tinycld.org/packages/text/translate"
)

// makeProductionFlush returns a FlushFn that the SaveCoordinator
// invokes for each text room. The flow is:
//
//  1. Snapshot the Y.Doc as ProseMirror JSON via translate.PMJSONFromYDoc.
//  2. Convert to .docx bytes via translate.PMJSONToDocx.
//  3. Reload the drive_items record and overwrite its `file` field.
//
// The returned closure is safe to call concurrently for different
// rooms; the SaveCoordinator never re-enters the same room concurrently.
//
// PMJSONToDocx builds an omnidoc *docx.Document per call — no
// process-global state, so concurrent flushes across rooms need no
// serialization. The named-return + deferred recover here converts any
// panic into an error so the SaveCoordinator's retry/backoff path can
// handle it instead of the broker goroutine going down.
func makeProductionFlush(app core.App, _ *Runtime) realtime.FlushFn {
	return func(ctx context.Context, driveItemID string, handle realtime.DocHandle) (returnedErr error) {
		defer func() {
			if r := recover(); r != nil {
				app.Logger().Error("text: flush panicked",
					"driveItemID", driveItemID, "panic", r)
				returnedErr = fmt.Errorf("text: flush panicked for %s: %v", driveItemID, r)
			}
		}()

		if handle == nil {
			return fmt.Errorf("text: flush called with nil handle for %s", driveItemID)
		}
		th, ok := handle.(*textDocHandle)
		if !ok {
			return fmt.Errorf("text: flush expected *textDocHandle, got %T", handle)
		}

		th.mu.Lock()
		closed := th.closed
		doc := th.doc
		th.mu.Unlock()
		if closed || doc == nil {
			return fmt.Errorf("text: flush on closed room %s", driveItemID)
		}

		pmJSON, err := translate.PMJSONFromYDoc(doc)
		if err != nil {
			return fmt.Errorf("text: serialize Y.Doc for %s: %w", driveItemID, err)
		}

		// Read the Yjs `suggestions` Y.Map so the docx emitter can
		// embed status / resolvedBy / note metadata into the
		// customXml part. The mark-bearing PM JSON above already
		// carries the per-mark id/authorId/ts the emitter needs for
		// <w:ins>/<w:del>; the Y.Map adds the lifecycle data that
		// lives outside the marks themselves.
		suggestionEntries := readSuggestionsMap(doc)

		item, err := app.FindRecordById(driveItemsCollection, driveItemID)
		if err != nil {
			return fmt.Errorf("text: load drive_items %s: %w", driveItemID, err)
		}

		resolveImage := makeDriveImageResolver(app, &th.images, item)
		docxBytes, _, err := translate.PMJSONToDocxWithResolverAndSuggestions(
			ctx, pmJSON, resolveImage, suggestionEntries,
		)
		if err != nil {
			return fmt.Errorf("text: PMJSONToDocx for %s: %w", driveItemID, err)
		}
		if len(docxBytes) == 0 {
			return fmt.Errorf("text: PMJSONToDocx produced empty bytes for %s", driveItemID)
		}

		// Preserve the source format on save: a doc opened from .rtf is
		// written back as RTF, docx stays docx. The editor's model is
		// docx-shaped, so RTF items convert docx->RTF here.
		outBytes, ext, err := docxBytesToSource(ctx, item.GetString("mime_type"), docxBytes)
		if err != nil {
			return fmt.Errorf("text: convert output for %s: %w", driveItemID, err)
		}

		// Reuse the original filename so URLs / mime detection stay
		// consistent. PocketBase will rename the on-disk blob to a
		// fresh hash on save, so the prior blob isn't overwritten in
		// place.
		filename := item.GetString("file")
		if filename == "" {
			filename = "untitled." + ext
		}
		fileRef, err := filesystem.NewFileFromBytes(outBytes, filename)
		if err != nil {
			return fmt.Errorf("text: build filesystem.File for %s: %w", driveItemID, err)
		}
		item.Set("file", fileRef)
		item.Set("size", len(outBytes))

		// Compute the content hashes + page-1 preview model from the same
		// ProseMirror snapshot we just serialized, then set the hashes on
		// the record and hand the rendered model to the process-local
		// preview queue — all before app.Save, so the throttled generic
		// drive hook can compare hashes and skip redundant thumbnail /
		// search-index regeneration. Image handling never fails the flush:
		// any decode error just yields a text-only thumbnail.
		regionHash, indexHash, model := buildPreview(resolveImage, pmJSON)
		item.Set("thumb_region_hash", regionHash)
		item.Set("index_hash", indexHash)
		previewqueue.Stash(driveItemID, previewqueue.Payload{
			Plaintext:  model.plaintext,
			RegionHash: regionHash,
			IndexHash:  indexHash,
			Page:       model.page,
		})

		if err := app.Save(item); err != nil {
			return fmt.Errorf("text: save drive_items %s: %w", driveItemID, err)
		}
		return nil
	}
}

// imageCache holds image bytes by the blob name they were read from, for
// the life of one room. Every save embeds every image in the document, and
// a storage read per image per save is the largest avoidable cost of a
// save; a room's images rarely change. The key is the stored blob name,
// which PocketBase changes on every write, so a re-uploaded image is a
// miss and never served from stale bytes.
type imageCache struct {
	mu    sync.Mutex
	bytes map[string][]byte
}

func (c *imageCache) get(key string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	b, ok := c.bytes[key]
	return b, ok
}

func (c *imageCache) put(key string, b []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.bytes == nil {
		c.bytes = map[string][]byte{}
	}
	c.bytes[key] = b
}

func (c *imageCache) clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.bytes = nil
}

// attachLegacyImage attaches a root-level image inserted before drive_items had
// attached_to to the document it appears in, so the document's viewers can
// load it. Only when the document's owner uploaded it: a src pasted from
// someone else's image must not hand that image to this document's viewers.
// Best-effort: a failure leaves the image as it was and the save goes on.
func attachLegacyImage(app core.App, image, doc *core.Record) {
	if doc == nil || image.Id == doc.Id || image.GetString("attached_to") != "" {
		return
	}
	// Inserted images live in the Drive root; an image filed in a folder
	// is a file its owner manages, not part of this document.
	if image.GetString("parent") != "" {
		return
	}
	if image.Collection().Fields.GetByName("attached_to") == nil {
		return
	}
	creator := image.GetString("created_by")
	if creator == "" || creator != doc.GetString("created_by") {
		return
	}
	image.Set("attached_to", doc.Id)
	if err := app.Save(image); err != nil {
		app.Logger().Warn("text: attach legacy image to its document failed",
			"imageID", image.Id, "docID", doc.Id, "err", err)
	}
}

// makeDriveImageResolver returns the ImageResolver the docx emitter uses
// to embed inserted images. The editor stores inserted images as
// /api/files/drive_items/<id>/<file> URLs (keeping the Y.Doc small);
// docx needs the actual bytes, so this reads them straight off the
// drive_items record via the PocketBase filesystem. We read the record's
// current `file` field rather than the name parsed from the URL, so an
// image whose blob was re-uploaded after insertion still resolves to the
// live bytes instead of 404ing on a stale name. A nil cache reads storage
// on every call. doc, when set, is the document being saved: see
// attachLegacyImage.
func makeDriveImageResolver(app core.App, cache *imageCache, doc *core.Record) translate.ImageResolver {
	return func(driveItemID, _ string) ([]byte, error) {
		item, err := app.FindRecordById(driveItemsCollection, driveItemID)
		if err != nil {
			return nil, fmt.Errorf("find drive_items %s: %w", driveItemID, err)
		}
		// Only an image embeds. Any other item a src names (a PDF, a
		// sheet) is dropped rather than copied into the docx, where every
		// reader of the document could download it.
		if !strings.HasPrefix(item.GetString("mime_type"), "image/") {
			return nil, fmt.Errorf("drive_items %s is not an image: %w", driveItemID, translate.ErrImageUnavailable)
		}
		attachLegacyImage(app, item, doc)
		stored := item.GetString("file")
		if stored == "" {
			return nil, fmt.Errorf("drive_items %s has no file", driveItemID)
		}
		cacheKey := driveItemID + "/" + stored
		if cache != nil {
			if b, ok := cache.get(cacheKey); ok {
				return b, nil
			}
		}

		fsys, err := app.NewFilesystem()
		if err != nil {
			return nil, fmt.Errorf("open filesystem: %w", err)
		}
		defer fsys.Close()

		reader, err := fsys.GetReader(item.BaseFilesPath() + "/" + stored)
		if err != nil {
			return nil, fmt.Errorf("read drive_items %s file %s: %w", driveItemID, stored, err)
		}
		defer reader.Close()

		data, err := io.ReadAll(reader)
		if err != nil {
			return nil, fmt.Errorf("read drive_items %s bytes: %w", driveItemID, err)
		}
		if cache != nil {
			cache.put(cacheKey, data)
		}
		return data, nil
	}
}

// previewBundle carries the page-1 preview model alongside the raw
// plaintext the search index needs.
type previewBundle struct {
	plaintext string
	page      textpreview.PageModel
}

// previewMaxLineWidth is the soft wrap width (in runes) used to break the
// region text into display lines for the page-1 thumbnail.
const previewMaxLineWidth = 90

// buildPreview derives the two content hashes and the page-1 preview model
// from the ProseMirror JSON snapshot the flush just serialized.
//
// The region hash folds in the identity of the first-paragraph image (if
// any) so swapping the image regenerates the thumbnail; the index hash is
// the plaintext alone, since images aren't searchable text. Any failure in
// image handling is swallowed — the worst case is a text-only thumbnail, and
// the flush must never fail because an image couldn't be decoded.
func buildPreview(resolve translate.ImageResolver, pmJSON []byte) (regionHash, indexHash string, bundle previewBundle) {
	var root translate.PMNode
	if err := json.Unmarshal(pmJSON, &root); err != nil {
		// A malformed snapshot shouldn't reach here (we just round-tripped
		// it through the docx emitter), but degrade to empty hashes rather
		// than fail the flush.
		return "", "", previewBundle{}
	}

	plaintext := pmPlainText(&root)

	decodedImage, imageIdentity := firstParagraphImage(resolve, &root)

	region, regionHash := textpreview.FirstRegionText(plaintext + imageIdentity)
	indexHash = textpreview.Hash(plaintext)

	bundle = previewBundle{
		plaintext: plaintext,
		page: textpreview.PageModel{
			Title: firstHeadingText(&root),
			Lines: regionLines(region),
			Image: decodedImage,
		},
	}
	return regionHash, indexHash, bundle
}

// pmPlainText walks the ProseMirror tree depth-first, collecting the text of
// every text node and separating block-level nodes (paragraphs, headings,
// etc.) with newlines. The result is the document's searchable plaintext.
func pmPlainText(n *translate.PMNode) string {
	if n == nil {
		return ""
	}
	if n.Type == translate.NodeTypeText {
		return n.Text
	}
	var parts []string
	for i := range n.Content {
		if t := pmPlainText(&n.Content[i]); t != "" {
			parts = append(parts, t)
		}
	}
	return strings.Join(parts, "\n")
}

// firstHeadingText returns the plaintext of the first heading node found
// depth-first, or "" if the document opens with no heading. Used as the
// thumbnail title.
func firstHeadingText(n *translate.PMNode) string {
	if n == nil {
		return ""
	}
	if n.Type == translate.NodeTypeHeading {
		return collectText(n)
	}
	for i := range n.Content {
		if t := firstHeadingText(&n.Content[i]); t != "" {
			return t
		}
	}
	return ""
}

// collectText concatenates the text of every descendant text node with no
// separator (used for a single block's title text).
func collectText(n *translate.PMNode) string {
	if n == nil {
		return ""
	}
	if n.Type == translate.NodeTypeText {
		return n.Text
	}
	var b strings.Builder
	for i := range n.Content {
		b.WriteString(collectText(&n.Content[i]))
	}
	return b.String()
}

// regionLines splits the region text into display lines: it breaks on
// newlines and hard-wraps over-long lines to previewMaxLineWidth runes so the
// page-1 thumbnail doesn't overflow its canvas.
func regionLines(region string) []string {
	var lines []string
	for _, raw := range strings.Split(region, "\n") {
		runes := []rune(raw)
		if len(runes) == 0 {
			lines = append(lines, "")
			continue
		}
		for len(runes) > previewMaxLineWidth {
			lines = append(lines, string(runes[:previewMaxLineWidth]))
			runes = runes[previewMaxLineWidth:]
		}
		lines = append(lines, string(runes))
	}
	return lines
}

// firstParagraphImage walks only the first block of the document
// depth-first, stopping at the first image node, and resolves its bytes into
// a decoded image plus a stable identity string (the src URL for drive
// images, or a content hash for data: URIs) that changes whenever the image
// changes. On any error it returns (nil, "") — a text-only thumbnail.
func firstParagraphImage(resolve translate.ImageResolver, root *translate.PMNode) (image.Image, string) {
	if root == nil || len(root.Content) == 0 {
		return nil, ""
	}
	img := findFirstImage(&root.Content[0])
	if img == nil {
		return nil, ""
	}
	src, _ := img.Attrs["src"].(string)
	if src == "" {
		return nil, ""
	}

	imgBytes, identity, ok := resolveImageBytes(resolve, src)
	if !ok {
		return nil, ""
	}
	decoded, _, err := image.Decode(bytes.NewReader(imgBytes))
	if err != nil {
		return nil, ""
	}
	return decoded, identity
}

// findFirstImage returns the first image node in a subtree, depth-first.
func findFirstImage(n *translate.PMNode) *translate.PMNode {
	if n == nil {
		return nil
	}
	if n.Type == translate.NodeTypeImage {
		return n
	}
	for i := range n.Content {
		if found := findFirstImage(&n.Content[i]); found != nil {
			return found
		}
	}
	return nil
}

// resolveImageBytes fetches the raw bytes for an image src and returns a
// stable identity string for it. Drive-file URLs resolve via the same
// resolver the docx emitter uses (so the bytes come from its cache),
// identified by their src URL; data: URIs decode the base64 body and are
// identified by a content hash. Returns ok=false on any failure.
func resolveImageBytes(resolve translate.ImageResolver, src string) (data []byte, identity string, ok bool) {
	if driveItemID, fileName, isDrive := parseDriveImageSrc(src); isDrive {
		b, err := resolve(driveItemID, fileName)
		if err != nil {
			return nil, "", false
		}
		return b, src, true
	}
	if strings.HasPrefix(src, "data:") {
		comma := strings.IndexByte(src, ',')
		if comma < 0 {
			return nil, "", false
		}
		b, err := base64.StdEncoding.DecodeString(src[comma+1:])
		if err != nil {
			return nil, "", false
		}
		return b, textpreview.Hash(string(b)), true
	}
	return nil, "", false
}

// parseDriveImageSrc extracts (driveItemID, fileName) from a PocketBase
// drive-file URL of the form ".../api/files/drive_items/<id>/<file>",
// tolerating a query string. Mirrors translate.parseDriveFileSrc (which is
// unexported) so the flush can resolve first-paragraph images for the
// thumbnail.
func parseDriveImageSrc(src string) (driveItemID, fileName string, ok bool) {
	const marker = "/api/files/drive_items/"
	idx := strings.Index(src, marker)
	if idx < 0 {
		return "", "", false
	}
	rest := src[idx+len(marker):]
	if q := strings.IndexByte(rest, '?'); q >= 0 {
		rest = rest[:q]
	}
	slash := strings.IndexByte(rest, '/')
	if slash <= 0 {
		return "", "", false
	}
	driveItemID = rest[:slash]
	fileName = rest[slash+1:]
	if driveItemID == "" || fileName == "" || strings.Contains(fileName, "/") {
		return "", "", false
	}
	return driveItemID, fileName, true
}
