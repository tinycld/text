package translate

// Image emission: a PM image (block or inline) is embedded as a media part via
// doc.AddImage and referenced by a docx.Drawing. The decode/validate pipeline
// (data: URIs + drive-file resolution + size/type caps) returns a plain
// extension string; the media part's extension drives its content type.

import (
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"net/url"
	"strings"

	"github.com/nathanstitt/doctaculous/pkg/docx"
)

// emuPerPx is 9525 EMU per CSS pixel (96 dpi), the inverse of the importer's
// emusToPixels.
const emuPerPx = 9525

// emitImageBlock embeds a block-level image as its own paragraph.
func (b *builder) emitImageBlock(out *[]docx.Block, node PMNode) error {
	dr, err := b.buildDrawing(node)
	if err != nil {
		return err
	}
	if dr == nil {
		return nil // dropped (validation) — warning already recorded
	}
	*out = append(*out, docx.Block{Paragraph: &docx.Paragraph{
		Content: []docx.ParaChild{{Drawing: dr}}}})
	return nil
}

// inlineImageChild embeds an image that appeared inside a paragraph's inline
// runs, returning the ParaChild (or nil when the image was dropped).
func (b *builder) inlineImageChild(node PMNode) (*docx.ParaChild, error) {
	dr, err := b.buildDrawing(node)
	if err != nil {
		return nil, err
	}
	if dr == nil {
		return nil, nil
	}
	return &docx.ParaChild{Drawing: dr}, nil
}

// buildDrawing decodes+validates the image src, embeds the bytes, and builds
// the docx.Drawing (extent, wrap, alt/title). Returns (nil, nil) when the image
// was dropped with a warning.
func (b *builder) buildDrawing(node PMNode) (*docx.Drawing, error) {
	src, _ := node.Attrs["src"].(string)
	if src == "" {
		return nil, fmt.Errorf("translate: image node missing src attr")
	}
	data, ext, skip, err := b.decodeAndValidateImage(src)
	if err != nil {
		return nil, err
	}
	if skip {
		return nil, nil
	}

	relID := b.doc.AddImage(deriveImageName(src, ext), data)
	dr := &docx.Drawing{RelID: relID}

	width := intAttr(node.Attrs, "width")
	height := intAttr(node.Attrs, "height")
	dr.WidthEMU = int64(width) * emuPerPx
	dr.HeightEMU = int64(height) * emuPerPx

	if alt, ok := node.Attrs["alt"].(string); ok && alt != "" {
		dr.Description = alt
	}
	if title, ok := node.Attrs["title"].(string); ok && title != "" {
		dr.Title = title
	}
	applyImageWrap(dr, node.Attrs)
	return dr, nil
}

// applyImageWrap maps the image's `wrap` attr onto the drawing's anchor / wrap
// fields:
//   - "left"  -> Anchored, square wrap, left align
//   - "right" -> Anchored, square wrap, right align
//   - "break" -> Anchored, topAndBottom wrap
//   - none / other -> inline (not anchored)
func applyImageWrap(dr *docx.Drawing, attrs map[string]any) {
	wrap, _ := attrs["wrap"].(string)
	switch wrap {
	case "left":
		dr.Anchored, dr.WrapKind, dr.AlignH = true, "square", "left"
	case "right":
		dr.Anchored, dr.WrapKind, dr.AlignH = true, "square", "right"
	case "break":
		dr.Anchored, dr.WrapKind = true, "topAndBottom"
	}
}

// decodeAndValidateImage runs the byte / MIME validation between the client src
// and the media part. Returns (data, ext, skip=true) when the image should be
// dropped with a warning (oversized / unsupported type). A non-nil error means
// a malformed URI to propagate. ext is a lowercase file extension (png/jpg/gif).
func (b *builder) decodeAndValidateImage(src string) ([]byte, string, bool, error) {
	if driveItemID, fileName, ok := parseDriveFileSrc(src); ok {
		return b.resolveDriveImage(src, driveItemID, fileName)
	}
	if strings.HasPrefix(src, "data:") {
		mediaType, _ := parseDataURIHeader(src)
		if mediaType != "" && !allowedImageMediaTypes[strings.ToLower(mediaType)] {
			b.addWarning(WarningUnsupportedImageType,
				fmt.Sprintf("image with media type %q dropped", mediaType))
			return nil, "", true, nil
		}
	}
	data, ext, err := decodeImageSrc(src)
	if err != nil {
		return nil, "", false, err
	}
	if len(data) > MaxImageBytes {
		b.addWarning(WarningImageTooLarge,
			fmt.Sprintf("image of %d bytes exceeded %d-byte cap and was dropped", len(data), MaxImageBytes))
		return nil, "", true, nil
	}
	return data, ext, false, nil
}

// resolveDriveImage fetches the bytes for an inserted drive-file image via
// b.imageResolver, infers the extension from the file name, and applies the
// size cap. With no resolver a drive URL is unsupported.
func (b *builder) resolveDriveImage(src, driveItemID, fileName string) ([]byte, string, bool, error) {
	if b.imageResolver == nil {
		return nil, "", false, fmt.Errorf(
			"translate: drive-file image src %q has no resolver (only data: URIs supported without one)", src)
	}
	ext := extensionToFormat(fileName)
	if ext == "" {
		b.addWarning(WarningUnsupportedImageType,
			fmt.Sprintf("drive image %q has unsupported extension; dropped", fileName))
		return nil, "", true, nil
	}
	data, err := b.imageResolver(driveItemID, fileName)
	if err != nil {
		return nil, "", false, fmt.Errorf("translate: resolve drive image %s/%s: %w", driveItemID, fileName, err)
	}
	if len(data) > MaxImageBytes {
		b.addWarning(WarningImageTooLarge,
			fmt.Sprintf("image of %d bytes exceeded %d-byte cap and was dropped", len(data), MaxImageBytes))
		return nil, "", true, nil
	}
	return data, ext, false, nil
}

// parseDriveFileSrc extracts (driveItemID, fileName) from a PocketBase
// drive-file URL ".../api/files/drive_items/<id>/<file>".
func parseDriveFileSrc(src string) (driveItemID, fileName string, ok bool) {
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

// extensionToFormat maps a stored file name's extension to a media-part
// extension (png / jpg / gif), reusing mediaTypeToFormat's accepted set.
func extensionToFormat(fileName string) string {
	dot := strings.LastIndexByte(fileName, '.')
	if dot < 0 {
		return ""
	}
	switch strings.ToLower(fileName[dot+1:]) {
	case "png":
		return "png"
	case "jpg", "jpeg":
		return "jpg"
	case "gif":
		return "gif"
	default:
		return ""
	}
}

// parseDataURIHeader returns the media type from a data: URI without decoding
// the body.
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

// decodeImageSrc accepts a data: URI, returning the raw bytes plus a media-part
// extension.
func decodeImageSrc(src string) ([]byte, string, error) {
	if strings.HasPrefix(src, "data:") {
		return decodeDataURI(src)
	}
	return nil, "", fmt.Errorf("translate: unsupported image src %q (only data: URIs supported in v1)", src)
}

func decodeDataURI(src string) ([]byte, string, error) {
	comma := strings.IndexByte(src, ',')
	if comma < 0 {
		return nil, "", fmt.Errorf("translate: malformed data URI")
	}
	header := src[:comma]
	body := src[comma+1:]
	mediaType := strings.TrimPrefix(header, "data:")
	mediaType = strings.SplitN(mediaType, ";", 2)[0]
	ext := mediaTypeToFormat(mediaType)
	if ext == "" {
		return nil, "", fmt.Errorf("translate: unsupported image media type %q", mediaType)
	}
	if !strings.Contains(header, "base64") {
		decoded, err := url.QueryUnescape(body)
		if err != nil {
			return nil, "", fmt.Errorf("translate: decode data URI: %w", err)
		}
		return []byte(decoded), ext, nil
	}
	data, err := base64.StdEncoding.DecodeString(body)
	if err != nil {
		return nil, "", fmt.Errorf("translate: decode base64: %w", err)
	}
	return data, ext, nil
}

// mediaTypeToFormat maps a data: URI media type to a media-part extension.
func mediaTypeToFormat(media string) string {
	switch strings.ToLower(media) {
	case "image/png":
		return "png"
	case "image/jpeg", "image/jpg":
		return "jpg"
	case "image/gif":
		return "gif"
	}
	return ""
}

// deriveImageName makes a deterministic filename for the embedded media part.
// A sha1 of the src dedupes the same image appearing twice.
func deriveImageName(src, ext string) string {
	h := sha1.Sum([]byte(src))
	if ext == "" {
		ext = "png"
	}
	return fmt.Sprintf("img_%x.%s", h[:6], ext)
}
