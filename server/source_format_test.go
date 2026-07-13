package text

import (
	"strings"
	"testing"

	"tinycld.org/packages/text/translate"
)

// A minimal but real RTF document with a bold run and two paragraphs.
const sampleRTF = `{\rtf1\ansi\deff0 {\fonttbl {\f0 Times New Roman;}}` +
	`\f0\fs24 Hello \b bold\b0  world.\par Second paragraph here.\par}`

func TestIsEditableMime(t *testing.T) {
	editable := []string{docxMimeType, rtfMimeType, rtfMimeTypeAlt}
	for _, mt := range editable {
		if !isEditableMime(mt) {
			t.Errorf("isEditableMime(%q) = false, want true", mt)
		}
	}
	for _, mt := range []string{"application/pdf", "image/png", "text/plain", ""} {
		if isEditableMime(mt) {
			t.Errorf("isEditableMime(%q) = true, want false", mt)
		}
	}
}

// TestRTFBridge_ImportPath mirrors the bootstrap: RTF bytes are normalized to
// docx, then the existing docx->PM walk runs and recovers the content.
func TestRTFBridge_ImportPath(t *testing.T) {
	docxBytes, err := sourceBytesToDocx(rtfMimeType, []byte(sampleRTF))
	if err != nil {
		t.Fatalf("sourceBytesToDocx: %v", err)
	}
	if len(docxBytes) == 0 {
		t.Fatal("sourceBytesToDocx produced empty docx")
	}

	pmJSON, _, _, err := translate.DocxToPMJSONWithSuggestions(docxBytes)
	if err != nil {
		t.Fatalf("DocxToPMJSONWithSuggestions on bridged docx: %v", err)
	}
	// The recovered PM JSON must carry the document text (proves the RTF
	// content survived RTF -> docx -> PM).
	s := string(pmJSON)
	for _, want := range []string{"Hello", "bold", "world", "Second paragraph"} {
		if !strings.Contains(s, want) {
			t.Errorf("bridged PM JSON missing %q; got: %s", want, s)
		}
	}
}

// TestRTFBridge_ExportPath mirrors the flush: the editor's docx output is
// converted back to RTF for an RTF-sourced item, and the RTF round-trips.
func TestRTFBridge_ExportPath(t *testing.T) {
	// Start from the docx the import path would produce.
	docxBytes, err := sourceBytesToDocx(rtfMimeType, []byte(sampleRTF))
	if err != nil {
		t.Fatalf("sourceBytesToDocx: %v", err)
	}

	out, ext, err := docxBytesToSource(rtfMimeType, docxBytes)
	if err != nil {
		t.Fatalf("docxBytesToSource(rtf): %v", err)
	}
	if ext != "rtf" {
		t.Errorf("ext = %q, want rtf", ext)
	}
	if !strings.HasPrefix(string(out), `{\rtf`) {
		t.Errorf("output is not RTF; prefix = %q", firstN(string(out), 12))
	}

	// A docx-sourced item must pass through untouched with a docx extension.
	same, ext2, err := docxBytesToSource(docxMimeType, docxBytes)
	if err != nil {
		t.Fatalf("docxBytesToSource(docx): %v", err)
	}
	if ext2 != "docx" {
		t.Errorf("docx ext = %q, want docx", ext2)
	}
	if len(same) != len(docxBytes) {
		t.Errorf("docx passthrough changed the bytes (%d -> %d)", len(docxBytes), len(same))
	}
}

// TestSourceBytesToDocx_EmptyAndDocx covers the passthrough branches.
func TestSourceBytesToDocx_EmptyAndDocx(t *testing.T) {
	// Empty input is returned as-is regardless of mime (never fed to the
	// RTF opener, which would error on empty bytes).
	got, err := sourceBytesToDocx(rtfMimeType, nil)
	if err != nil || got != nil {
		t.Errorf("empty rtf: got (%v, %v), want (nil, nil)", got, err)
	}
	// docx input passes through byte-identical.
	docx := []byte("PK\x03\x04 not-really-a-zip-but-passthrough")
	got, err = sourceBytesToDocx(docxMimeType, docx)
	if err != nil {
		t.Fatalf("docx passthrough err: %v", err)
	}
	if string(got) != string(docx) {
		t.Error("docx passthrough altered bytes")
	}
}

func firstN(s string, n int) string {
	if len(s) < n {
		return s
	}
	return s[:n]
}
