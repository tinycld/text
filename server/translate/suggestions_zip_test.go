package translate

import (
	"archive/zip"
	"bytes"
	"io"
	"testing"
)

// TestPMToDocxIncludesSuggestionsCustomXMLPart asserts that when the
// PM tree carries suggestedInsert / suggestedDelete marks (so the
// emitter queues spans) and the caller passes matching entries, the
// resulting docx zip contains a customXml/tinycld-suggestions.xml part
// and a [Content_Types].xml Override that references it.
func TestPMToDocxIncludesSuggestionsCustomXMLPart(t *testing.T) {
	pmJSON := []byte(`{
		"type": "doc",
		"content": [{
			"type": "paragraph",
			"content": [{
				"type": "text",
				"text": "proposed",
				"marks": [{
					"type": "suggestedInsert",
					"attrs": {"suggestionId": "s1", "authorId": "uo_a", "ts": 1700000000000}
				}]
			}]
		}]
	}`)
	entries := []SuggestionMapEntry{
		{ID: "s1", AuthorID: "uo_a", CreatedAt: 1700000000000, Status: "open"},
	}
	docxBytes, _, err := PMJSONToDocxWithSuggestions(pmJSON, entries)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}

	r, err := zip.NewReader(bytes.NewReader(docxBytes), int64(len(docxBytes)))
	if err != nil {
		t.Fatalf("zip: %v", err)
	}
	var found []byte
	for _, f := range r.File {
		if f.Name == "customXml/tinycld-suggestions.xml" {
			rc, err := f.Open()
			if err != nil {
				t.Fatalf("open: %v", err)
			}
			data, err := io.ReadAll(rc)
			rc.Close()
			if err != nil {
				t.Fatalf("read: %v", err)
			}
			found = data
		}
	}
	if found == nil {
		t.Fatalf("customXml/tinycld-suggestions.xml missing from docx")
	}
	if !bytes.Contains(found, []byte(`id="s1"`)) {
		t.Errorf("expected entry id=s1 in part body; got:\n%s", found)
	}

	// Also verify Content_Types.xml has the Override
	for _, f := range r.File {
		if f.Name == "[Content_Types].xml" {
			rc, _ := f.Open()
			ct, _ := io.ReadAll(rc)
			rc.Close()
			if !bytes.Contains(ct, []byte("tinycld-suggestions.xml")) {
				t.Errorf("expected Content_Types.xml to reference suggestions part; got:\n%s", ct)
			}
		}
	}
}

// TestPMToDocxOmitsCustomXMLPartWhenNoSuggestions asserts that a doc
// without any suggestion marks and no entries does NOT get the custom
// XML part — Word readers shouldn't see a phantom part that has no
// matching <w:ins>/<w:del> to correlate with.
func TestPMToDocxOmitsCustomXMLPartWhenNoSuggestions(t *testing.T) {
	pmJSON := []byte(`{
		"type": "doc",
		"content": [{
			"type": "paragraph",
			"content": [{"type": "text", "text": "plain"}]
		}]
	}`)
	docxBytes, _, err := PMJSONToDocxWithSuggestions(pmJSON, nil)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}

	r, err := zip.NewReader(bytes.NewReader(docxBytes), int64(len(docxBytes)))
	if err != nil {
		t.Fatalf("zip: %v", err)
	}
	for _, f := range r.File {
		if f.Name == "customXml/tinycld-suggestions.xml" {
			t.Errorf("expected NO suggestions part for a doc without suggestion marks; found one")
		}
	}
}
