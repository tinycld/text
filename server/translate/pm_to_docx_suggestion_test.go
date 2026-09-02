package translate

import (
	"archive/zip"
	"bytes"
	"io"
	"strings"
	"testing"
)

func extractDocumentXMLForSuggestionTest(t *testing.T, docxBytes []byte) []byte {
	t.Helper()
	r, err := zip.NewReader(bytes.NewReader(docxBytes), int64(len(docxBytes)))
	if err != nil {
		t.Fatalf("zip: %v", err)
	}
	for _, f := range r.File {
		if f.Name == "word/document.xml" {
			rc, err := f.Open()
			if err != nil {
				t.Fatalf("open: %v", err)
			}
			defer rc.Close()
			data, err := io.ReadAll(rc)
			if err != nil {
				t.Fatalf("read: %v", err)
			}
			return data
		}
	}
	t.Fatalf("word/document.xml not found in docx")
	return nil
}

// TestPMToDocxEmitsWIns confirms a suggestedInsert mark on a text
// run produces <w:ins author="..." date="..." w:id="..."> wrapping
// the <w:r> in the output document.xml.
func TestPMToDocxEmitsWIns(t *testing.T) {
	pmJSON := []byte(`{
		"type": "doc",
		"content": [{
			"type": "paragraph",
			"content": [{
				"type": "text",
				"text": "proposed",
				"marks": [{
					"type": "suggestedInsert",
					"attrs": {
						"suggestionId": "s_alice_1",
						"authorId": "uo_alice",
						"ts": 1700000000000
					}
				}]
			}]
		}]
	}`)

	docxBytes, _, err := PMJSONToDocxWithWarnings(t.Context(), pmJSON)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}

	docXML := extractDocumentXMLForSuggestionTest(t, docxBytes)
	if !bytes.Contains(docXML, []byte("<w:ins ")) {
		t.Errorf("expected <w:ins> in document.xml; got:\n%s", docXML)
	}
	if !bytes.Contains(docXML, []byte(`w:author="uo_alice"`)) {
		t.Errorf("expected w:author=uo_alice in <w:ins>; got:\n%s", docXML)
	}
	if !bytes.Contains(docXML, []byte(`w:id="1"`)) {
		t.Errorf("expected w:id=\"1\" in <w:ins>; got:\n%s", docXML)
	}
}

// TestPMToDocxEmitsWDel confirms a suggestedDelete mark produces
// <w:del>...<w:delText>...</w:delText>...</w:del>.
func TestPMToDocxEmitsWDel(t *testing.T) {
	pmJSON := []byte(`{
		"type": "doc",
		"content": [{
			"type": "paragraph",
			"content": [{
				"type": "text",
				"text": "to remove",
				"marks": [{
					"type": "suggestedDelete",
					"attrs": {
						"suggestionId": "s_bob_1",
						"authorId": "uo_bob",
						"ts": 1700000000000
					}
				}]
			}]
		}]
	}`)

	docxBytes, _, err := PMJSONToDocxWithWarnings(t.Context(), pmJSON)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}

	docXML := extractDocumentXMLForSuggestionTest(t, docxBytes)
	if !bytes.Contains(docXML, []byte("<w:del ")) {
		t.Errorf("expected <w:del> in document.xml; got:\n%s", docXML)
	}
	if !bytes.Contains(docXML, []byte("<w:delText")) {
		t.Errorf("expected <w:delText> in document.xml; got:\n%s", docXML)
	}
	if !bytes.Contains(docXML, []byte("to remove")) {
		t.Errorf("expected deleted text 'to remove' preserved in delText; got:\n%s",
			docXML)
	}
	if !bytes.Contains(docXML, []byte(`w:author="uo_bob"`)) {
		t.Errorf("expected w:author=uo_bob; got:\n%s", docXML)
	}
}

// TestPMToDocxLayeredSuggestionsProduceNestedWrappers confirms the
// Case 2c scenario: two suggestedDelete marks on the same run produce
// two nested <w:del> elements (each with its own w:id and author).
func TestPMToDocxLayeredSuggestionsProduceNestedWrappers(t *testing.T) {
	pmJSON := []byte(`{
		"type": "doc",
		"content": [{
			"type": "paragraph",
			"content": [{
				"type": "text",
				"text": "doomed",
				"marks": [
					{
						"type": "suggestedDelete",
						"attrs": {
							"suggestionId": "s_bob",
							"authorId": "uo_bob",
							"ts": 1700000000000
						}
					},
					{
						"type": "suggestedDelete",
						"attrs": {
							"suggestionId": "s_carol",
							"authorId": "uo_carol",
							"ts": 1700000010000
						}
					}
				]
			}]
		}]
	}`)

	docxBytes, _, err := PMJSONToDocxWithWarnings(t.Context(), pmJSON)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}

	docXML := extractDocumentXMLForSuggestionTest(t, docxBytes)
	delCount := strings.Count(string(docXML), "<w:del ")
	if delCount != 2 {
		t.Errorf("expected 2 <w:del> opening tags, got %d; doc:\n%s",
			delCount, docXML)
	}
	if !bytes.Contains(docXML, []byte(`w:author="uo_bob"`)) {
		t.Errorf("expected author uo_bob in one wrapper")
	}
	if !bytes.Contains(docXML, []byte(`w:author="uo_carol"`)) {
		t.Errorf("expected author uo_carol in another wrapper")
	}
}
