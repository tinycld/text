package translate

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"testing"
)

func TestDocxToPMRoundTripPreservesInsertMark(t *testing.T) {
	// Round-trip: PM → docx → PM and assert the suggestedInsert mark
	// survives with the right attrs.
	pmJSON := []byte(`{
		"type": "doc",
		"content": [{
			"type": "paragraph",
			"content": [{
				"type": "text",
				"text": "proposed",
				"marks": [{
					"type": "suggestedInsert",
					"attrs": {"suggestionId": "s_alice", "authorId": "uo_alice", "ts": 1700000000000}
				}]
			}]
		}]
	}`)
	entries := []SuggestionMapEntry{
		{ID: "s_alice", AuthorID: "uo_alice", CreatedAt: 1700000000000, Status: "open"},
	}
	docxBytes, _, err := PMJSONToDocxWithSuggestions(t.Context(), pmJSON, entries)
	if err != nil {
		t.Fatalf("PM→docx: %v", err)
	}

	roundtripped, _, err := DocxToPMJSON(t.Context(), docxBytes)
	if err != nil {
		t.Fatalf("docx→PM: %v", err)
	}

	var doc PMNode
	if err := json.Unmarshal(roundtripped, &doc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(doc.Content) == 0 || len(doc.Content[0].Content) == 0 {
		t.Fatalf("unexpected shape: %+v", doc)
	}
	text := doc.Content[0].Content[0]
	var insMark *PMMark
	for i := range text.Marks {
		if text.Marks[i].Type == MarkTypeSuggestedInsert {
			insMark = &text.Marks[i]
			break
		}
	}
	if insMark == nil {
		t.Fatalf("suggestedInsert mark missing on roundtripped text: %+v", text.Marks)
	}
	if insMark.Attrs["suggestionId"] != "s_alice" {
		t.Errorf("suggestionId: %v", insMark.Attrs["suggestionId"])
	}
	if insMark.Attrs["authorId"] != "uo_alice" {
		t.Errorf("authorId: %v", insMark.Attrs["authorId"])
	}
}

func TestDocxToPMRoundTripPreservesDeleteMark(t *testing.T) {
	pmJSON := []byte(`{
		"type": "doc",
		"content": [{
			"type": "paragraph",
			"content": [{
				"type": "text",
				"text": "doomed",
				"marks": [{
					"type": "suggestedDelete",
					"attrs": {"suggestionId": "s_bob", "authorId": "uo_bob", "ts": 1700000000000}
				}]
			}]
		}]
	}`)
	entries := []SuggestionMapEntry{
		{ID: "s_bob", AuthorID: "uo_bob", CreatedAt: 1700000000000, Status: "open"},
	}
	docxBytes, _, err := PMJSONToDocxWithSuggestions(t.Context(), pmJSON, entries)
	if err != nil {
		t.Fatalf("PM→docx: %v", err)
	}

	roundtripped, _, err := DocxToPMJSON(t.Context(), docxBytes)
	if err != nil {
		t.Fatalf("docx→PM: %v", err)
	}

	var doc PMNode
	if err := json.Unmarshal(roundtripped, &doc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(doc.Content) == 0 || len(doc.Content[0].Content) == 0 {
		t.Fatalf("unexpected shape: %+v", doc)
	}
	text := doc.Content[0].Content[0]
	if text.Text != "doomed" {
		t.Errorf("expected text 'doomed' preserved, got %q", text.Text)
	}
	var delMark *PMMark
	for i := range text.Marks {
		if text.Marks[i].Type == MarkTypeSuggestedDelete {
			delMark = &text.Marks[i]
			break
		}
	}
	if delMark == nil {
		t.Fatalf("suggestedDelete mark missing on roundtripped text: %+v", text.Marks)
	}
}

// TestDocxToPMWordAuthoredSynthesizesId simulates a Word-authored docx
// that has <w:ins> but no tinycld customXml part. The parser should
// still recognize the wrapper and synthesize a stable suggestion id
// from (w:id, w:author).
func TestDocxToPMWordAuthoredSynthesizesId(t *testing.T) {
	// Build a docx from PM JSON the normal way, then strip the custom
	// XML part to simulate a Word-authored file. The resulting docx
	// has only the <w:ins> wrapper in word/document.xml.
	pmJSON := []byte(`{
		"type": "doc",
		"content": [{
			"type": "paragraph",
			"content": [{
				"type": "text",
				"text": "word-edit",
				"marks": [{
					"type": "suggestedInsert",
					"attrs": {"suggestionId": "s_word", "authorId": "wordy", "ts": 1700000000000}
				}]
			}]
		}]
	}`)
	entries := []SuggestionMapEntry{
		{ID: "s_word", AuthorID: "wordy", CreatedAt: 1700000000000, Status: "open"},
	}
	docxBytes, _, err := PMJSONToDocxWithSuggestions(t.Context(), pmJSON, entries)
	if err != nil {
		t.Fatalf("PM→docx: %v", err)
	}

	// Strip the custom XML part from the zip to simulate Word output.
	stripped := stripCustomXMLPart(t, docxBytes)

	roundtripped, _, err := DocxToPMJSON(t.Context(), stripped)
	if err != nil {
		t.Fatalf("docx→PM: %v", err)
	}

	var doc PMNode
	if err := json.Unmarshal(roundtripped, &doc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(doc.Content) == 0 || len(doc.Content[0].Content) == 0 {
		t.Fatalf("unexpected shape: %+v", doc)
	}
	text := doc.Content[0].Content[0]
	var insMark *PMMark
	for i := range text.Marks {
		if text.Marks[i].Type == MarkTypeSuggestedInsert {
			insMark = &text.Marks[i]
			break
		}
	}
	if insMark == nil {
		t.Fatalf("suggestedInsert mark missing on roundtripped text: %+v", text.Marks)
	}
	// Without the customXml mapping, the parser synthesizes a stable
	// id from (w:id, w:author). w:id starts at 1 in our emitter.
	gotID, _ := insMark.Attrs["suggestionId"].(string)
	if gotID != "docx:1:wordy" {
		t.Errorf("synthesized suggestionId: got %q, want %q", gotID, "docx:1:wordy")
	}
	if insMark.Attrs["authorId"] != "wordy" {
		t.Errorf("authorId: %v", insMark.Attrs["authorId"])
	}
}

// stripCustomXMLPart rewrites a docx zip with the
// customXml/tinycld-suggestions.xml part removed.
func stripCustomXMLPart(t *testing.T, docx []byte) []byte {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(docx), int64(len(docx)))
	if err != nil {
		t.Fatalf("zip.NewReader: %v", err)
	}
	var out bytes.Buffer
	zw := zip.NewWriter(&out)
	for _, f := range zr.File {
		if f.Name == "customXml/tinycld-suggestions.xml" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("open %s: %v", f.Name, err)
		}
		w, err := zw.Create(f.Name)
		if err != nil {
			t.Fatalf("create %s: %v", f.Name, err)
		}
		if _, err := io.Copy(w, rc); err != nil {
			t.Fatalf("copy %s: %v", f.Name, err)
		}
		_ = rc.Close()
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	return out.Bytes()
}
