package text

import (
	"bytes"
	"context"
	"fmt"

	"github.com/nathanstitt/doctaculous/pkg/doctaculous"
)

// The text editor's model is docx-shaped: import walks a low-level
// *docx.Document into ProseMirror, and export builds a *docx.Document back.
// RTF documents are supported by bridging through docx at the byte level —
// doctaculous converts RTF <-> DOCX losslessly enough for the editor, and
// this keeps the entire ProseMirror pipeline (tracked changes, images,
// tables) unchanged. The bridge lives here so bootstrap/flush/render share
// one definition of "which mimes are editable" and how to convert.

// rtfMimeType / rtfMimeTypeAlt are the two MIME types browsers report for
// .rtf uploads; both map to doctaculous FormatRTF.
const (
	rtfMimeType    = "application/rtf"
	rtfMimeTypeAlt = "text/rtf"
)

// isEditableMime reports whether the text editor can open a drive item with
// this mime — docx natively, RTF via the bridge.
func isEditableMime(mimeType string) bool {
	switch mimeType {
	case docxMimeType, rtfMimeType, rtfMimeTypeAlt:
		return true
	default:
		return false
	}
}

// isRTFMime reports whether the mime is one of the RTF variants.
func isRTFMime(mimeType string) bool {
	return mimeType == rtfMimeType || mimeType == rtfMimeTypeAlt
}

// sourceBytesToDocx normalizes a drive item's stored bytes to docx so the
// docx-shaped import/render pipeline can consume them. docx passes through
// untouched; RTF is converted via doctaculous. Any other mime is a caller
// bug — the editable-mime gate should have rejected it upstream.
func sourceBytesToDocx(mimeType string, data []byte) ([]byte, error) {
	if len(data) == 0 || !isRTFMime(mimeType) {
		return data, nil
	}
	doc, err := doctaculous.OpenBytesAs(doctaculous.FormatRTF, data)
	if err != nil {
		return nil, fmt.Errorf("text: open rtf: %w", err)
	}
	var buf bytes.Buffer
	if err := doc.WriteDOCX(context.Background(), &buf, doctaculous.DOCXOptions{}); err != nil {
		return nil, fmt.Errorf("text: rtf->docx: %w", err)
	}
	return buf.Bytes(), nil
}

// docxBytesToSource converts the docx bytes the editor produces back into the
// item's original format for saving. docx items keep the docx bytes; RTF items
// get RTF back so opening a .rtf and saving preserves the format ("own your
// data"). Returns the bytes plus the filename extension the flush should use.
func docxBytesToSource(mimeType string, docxBytes []byte) (out []byte, ext string, err error) {
	if !isRTFMime(mimeType) {
		return docxBytes, "docx", nil
	}
	doc, err := doctaculous.OpenBytesAs(doctaculous.FormatDOCX, docxBytes)
	if err != nil {
		return nil, "", fmt.Errorf("text: reopen docx for rtf save: %w", err)
	}
	var buf bytes.Buffer
	if err := doc.WriteRTF(context.Background(), &buf, doctaculous.RTFOptions{}); err != nil {
		return nil, "", fmt.Errorf("text: docx->rtf: %w", err)
	}
	return buf.Bytes(), "rtf", nil
}
