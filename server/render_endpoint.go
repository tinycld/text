package text

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"

	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/packages/text/render"
	"tinycld.org/packages/text/translate"
)

// docxMimeType is the canonical Office Open XML wordprocessing
// MIME. The text render endpoint refuses any drive item with a
// different mime — a docx parser run on, say, a PDF would either
// 500 with an opaque error or, worse, leak garbled bytes through
// the renderer.
const docxMimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

// registerRenderAPI binds the text HTTP render endpoint. Called from
// Register at startup. The endpoint runs through the standard PB auth
// middleware (so re.Auth is non-nil) and additionally enforces drive
// share access via resolveShareRole — same predicate the realtime
// authorize uses.
//
// Mirrors calc/server/api.go::registerAPI verbatim. The two endpoints
// (/api/calc/render and /api/text/render) are deliberately structured
// the same so client-side `fetchRenderedHtml` can dispatch by mime
// without per-package branching.
func registerRenderAPI(app core.App) {
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.GET("/api/text/render/{id}", func(re *core.RequestEvent) error {
			return handleRender(app, re)
		}).BindFunc(requireAuthText)
		return e.Next()
	})
}

// requireAuthText rejects unauthenticated requests with a 401. PB
// sets re.Auth from the Authorization header (Bearer token) or from
// the pb_auth cookie — both populated by core's serve middleware
// before our handler runs.
func requireAuthText(re *core.RequestEvent) error {
	if re.Auth == nil {
		return re.UnauthorizedError("Authentication required", nil)
	}
	return re.Next()
}

// handleRender returns the rendered HTML fragment for the drive_item
// identified by `:id`. The response is a sanitized content fragment
// containing only `tinycld-text*` classes — no <html>, no <head>, no
// inline styles. Clients (preview iframe / print envelope) wrap it
// with their own CSS.
//
// Query params:
//   - images:  "url" (default) or "embed". Embed mode resolves any
//     non-data: image src through PocketBase's file system
//     and inlines the bytes as a base64 data URI. Used by
//     print where the renderer's output is handed to
//     expo-print (native) or a print iframe (web) that
//     can't carry the user's auth cookie to fetch images.
//
// ETag: derived from drive_item `updated` + renderer version. Honors
// `If-None-Match` → 304.
func handleRender(app core.App, re *core.RequestEvent) error {
	driveItemID := re.Request.PathValue("id")
	if driveItemID == "" {
		return re.BadRequestError("missing drive_item id", nil)
	}
	// resolveShareRole returns errNoShare for both "no row exists" and
	// "row belongs to a different org" — the role itself isn't needed
	// for render (read-only operation; viewers can render).
	if _, err := resolveShareRole(app, re.Auth.Id, driveItemID); err != nil {
		return re.ForbiddenError("no access to this drive item", nil)
	}
	item, err := app.FindRecordById(driveItemsCollection, driveItemID)
	if err != nil {
		return re.NotFoundError("drive item not found", err)
	}
	return writeRenderedItem(app, re, item)
}

// writeRenderedItem performs mime validation, ETag handling, and writes
// the rendered (and sanitized) HTML for a drive_item. Shared by the
// authenticated render endpoint and the public share-link render
// endpoint — both arrive here after their own access check, so this
// function performs no authorization.
func writeRenderedItem(app core.App, re *core.RequestEvent, item *core.Record) error {
	// Mime validation: the renderer's pipeline (DocxToPMJSON →
	// PMJSONToHTML) consumes docx bytes; RTF is bridged to docx in
	// RenderItemHTML. Reading bytes from a PDF / image / arbitrary blob
	// and feeding them through would surface as an opaque 500 — return a
	// clean 4xx instead so callers can distinguish "wrong content type"
	// from "renderer crashed".
	if !isEditableMime(item.GetString("mime_type")) {
		return re.BadRequestError("not an editable document", nil)
	}

	etag := renderETag(item.Id, item.GetString("updated"))
	if match := re.Request.Header.Get("If-None-Match"); match == etag {
		re.Response.Header().Set("ETag", etag)
		re.Response.Header().Set("Cache-Control", "private, max-age=0, must-revalidate")
		re.Response.WriteHeader(304)
		return nil
	}

	images := translate.ImageMode(re.Request.URL.Query().Get("images"))
	if images == "" {
		images = translate.ImageModeURL
	}

	// The embed fetcher authorizes each embedded image against the
	// CALLER, not the document — a doc's content is user-authored and
	// can reference arbitrary records, so "may render the doc" must not
	// imply "may read every file the doc points at". Nil-guarded because
	// a share-link caller reaching this shared writer has no auth
	// record; the fetcher fails closed on an empty user ID.
	authUserID := ""
	if re.Auth != nil {
		authUserID = re.Auth.Id
	}

	clean, err := RenderItemHTML(app, item, images, authUserID)
	if err != nil {
		return re.InternalServerError("could not render document", err)
	}

	re.Response.Header().Set("Content-Type", "text/html; charset=utf-8")
	re.Response.Header().Set("ETag", etag)
	re.Response.Header().Set("Cache-Control", "private, max-age=0, must-revalidate")
	_, _ = re.Response.Write([]byte(clean))
	return nil
}

// RenderItemHTML reads a docx drive_item's bytes and returns the
// sanitized HTML fragment. Exported so the public share-link render path
// (registered in this package) can reuse it after validating a share
// session — the members are separate modules, so cross-package reuse
// goes through exported funcs here, not imports of drive.
//
// authUserID identifies the CALLER for per-image authorization in
// embed mode: each embedded drive-file src is checked against that
// user's share access before its bytes are inlined. Pass "" for
// callers without an authenticated user (e.g. a share-link session) —
// embed fetches then fail closed and the images are dropped.
func RenderItemHTML(app core.App, item *core.Record, images translate.ImageMode, authUserID string) (string, error) {
	rawBytes, err := readDriveItemBytes(app, item)
	if err != nil {
		return "", fmt.Errorf("could not read file: %w", err)
	}
	// RTF items are bridged to docx so DocxToHTML below is format-agnostic.
	docxBytes, err := sourceBytesToDocx(item.GetString("mime_type"), rawBytes)
	if err != nil {
		return "", fmt.Errorf("could not normalize source: %w", err)
	}

	var fragment string
	if len(docxBytes) == 0 {
		fragment = `<article class="tinycld-text"></article>`
	} else {
		opts := translate.HTMLRenderOpts{Images: images}
		// Embed mode fetches image bytes from drive's filesystem. We
		// only wire the fetcher when needed; URL mode skips the
		// closure construction so docx-imported images (which carry
		// data: URIs already) pass through without any callback work.
		if images == translate.ImageModeEmbed {
			opts.EmbedFetcher = makeEmbedFetcher(app, authUserID)
		}
		// DocxToHTML walks the parsed PMNode tree directly to HTML —
		// no JSON marshal/unmarshal in the render path. Warnings are
		// discarded here; the bootstrap path captures them on import.
		var renderErr error
		fragment, _, renderErr = translate.DocxToHTML(docxBytes, opts)
		if renderErr != nil {
			return "", renderErr
		}
	}

	return render.Sanitize(fragment)
}

// renderETag derives an opaque ETag for a render request. Composed
// of the renderer version + the drive_item's `updated` timestamp so
// the cached preview invalidates both when the file changes and when
// the renderer itself does. Mirrors calc/server/api.go::renderETag
// verbatim — same formula, different RendererVersion namespace.
func renderETag(driveItemID, updated string) string {
	sum := sha256.Sum256([]byte(driveItemID + "|" + updated + "|" + render.RendererVersion))
	return fmt.Sprintf(`"%s"`, hex.EncodeToString(sum[:16]))
}

// makeEmbedFetcher returns an EmbedFetcher that resolves PocketBase
// file URLs to their stored bytes. The fetcher is constructed per
// request so it captures the live app instance; failure to fetch
// any single image drops only that image (returns an error to the
// translate package, which translates to an empty src and the image
// is omitted) rather than failing the whole render.
//
// The fetcher accepts:
//
//   - Absolute http(s) URLs that look like PocketBase file URLs of
//     the form .../api/files/drive_items/<recordId>/<filename>?…
//     The host portion is ignored — we use the path to look up the
//     same file in this server's filesystem.
//
// Anything else (off-domain URLs, non-drive_items collections,
// malformed inputs) returns an error so the renderer drops the image
// rather than embedding bytes we can't verify.
//
// Authorization: the src comes straight from user-authored document
// content, and app.FindRecordById bypasses PocketBase collection
// rules — so this fetcher must re-impose the read authorization PB
// would normally enforce. Only drive_items records are resolvable,
// and only when authUserID holds a live share on that exact record
// (resolveShareRole — the same org-constrained predicate that gates
// the render target, realtime room admission, and write access).
// Without this, any editor could embed another org's file URL and
// exfiltrate its bytes through the rendered output.
func makeEmbedFetcher(app core.App, authUserID string) translate.EmbedFetcher {
	return func(src string) (string, []byte, error) {
		coll, recID, fileName, ok := parseDriveFileURL(src)
		if !ok {
			return "", nil, fmt.Errorf("text render: unsupported embed source")
		}
		if coll != driveItemsCollection {
			return "", nil, fmt.Errorf("text render: embed collection not allowed")
		}
		// Fail closed when the caller has no authenticated identity
		// (e.g. a future share-link render) — dropping images is safe;
		// serving them without a subject to authorize is not.
		if authUserID == "" {
			return "", nil, fmt.Errorf("text render: embed fetch requires an authenticated user")
		}
		if _, err := resolveShareRole(app, authUserID, recID); err != nil {
			return "", nil, fmt.Errorf("text render: no access to embedded drive item: %w", err)
		}
		record, err := app.FindRecordById(driveItemsCollection, recID)
		if err != nil {
			return "", nil, err
		}
		fsys, err := app.NewFilesystem()
		if err != nil {
			return "", nil, err
		}
		defer fsys.Close()
		key := record.BaseFilesPath() + "/" + fileName
		rdr, err := fsys.GetReader(key)
		if err != nil {
			return "", nil, err
		}
		defer rdr.Close()
		buf, err := readCappedBytes(rdr, MaxDocxBytes)
		if err != nil {
			return "", nil, err
		}
		return mimeFromFilename(fileName), buf, nil
	}
}

// parseDriveFileURL extracts (collection, recordID, fileName) from a
// PocketBase file URL of the shape:
//
//	scheme://host[:port]/api/files/<collection>/<recordId>/<filename>[?token=…]
//
// Returns ok=false for anything else, including relative paths,
// missing path segments, and filenames that aren't a single bare
// segment. We deliberately don't require a specific scheme/host
// because dev deploys vary; the file existence check happens via
// app.FindRecordById which enforces that the record is in this
// PocketBase instance.
func parseDriveFileURL(src string) (collection, recordID, fileName string, ok bool) {
	// Strip query string.
	if idx := indexByte(src, '?'); idx >= 0 {
		src = src[:idx]
	}
	// Find /api/files/ anchor.
	anchor := "/api/files/"
	idx := indexSubstr(src, anchor)
	if idx < 0 {
		return "", "", "", false
	}
	rest := src[idx+len(anchor):]
	// Split into <collection>/<recordId>/<filename>.
	first := indexByte(rest, '/')
	if first <= 0 {
		return "", "", "", false
	}
	collection = rest[:first]
	rest = rest[first+1:]
	second := indexByte(rest, '/')
	if second <= 0 {
		return "", "", "", false
	}
	recordID = rest[:second]
	fileName = rest[second+1:]
	if !isSafeFileSegment(fileName) {
		return "", "", "", false
	}
	return collection, recordID, fileName, true
}

// isSafeFileSegment reports whether name is a bare single-segment
// filename. The parsed fileName is joined verbatim into the record's
// storage key (BaseFilesPath() + "/" + fileName), so a separator or a
// ".." sequence could address bytes outside that record's file
// directory. PocketBase-stored filenames never legitimately contain
// any of these, so rejecting costs nothing.
func isSafeFileSegment(name string) bool {
	if name == "" || indexSubstr(name, "..") >= 0 {
		return false
	}
	for i := 0; i < len(name); i++ {
		if name[i] == '/' || name[i] == '\\' {
			return false
		}
	}
	return true
}

// mimeFromFilename returns a conservative MIME type for an image
// filename. Only the raster formats the sanitizer's data: URI
// allowlist permits are returned (png / jpeg / gif / webp); anything
// else falls back to image/png so the renderer's downstream sanitizer
// doesn't reject the data: URI outright. The actual image bytes are
// what the browser uses to decode, not the MIME hint — the latter
// only steers <img> rendering.
func mimeFromFilename(name string) string {
	dot := lastIndexByte(name, '.')
	if dot < 0 {
		return "image/png"
	}
	ext := lowerASCII(name[dot:])
	switch ext {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	}
	return "image/png"
}

// Tiny string helpers kept local so this file doesn't pull in
// strings/bytes for trivial operations.

func indexByte(s string, c byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == c {
			return i
		}
	}
	return -1
}

func lastIndexByte(s string, c byte) int {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == c {
			return i
		}
	}
	return -1
}

func indexSubstr(s, sub string) int {
	if len(sub) == 0 {
		return 0
	}
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func lowerASCII(s string) string {
	out := make([]byte, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		out[i] = c
	}
	return string(out)
}
