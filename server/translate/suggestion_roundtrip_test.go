package translate

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestPhase2cSmoke_FullRoundTripPreservesSuggestionsAndEntries(t *testing.T) {
	// Realistic scenario: a doc with three suggestions — one open
	// insert plus a layered Case 2c delete pair.
	pmJSON := []byte(`{
		"type": "doc",
		"content": [
			{
				"type": "paragraph",
				"content": [{
					"type": "text",
					"text": "open-insert",
					"marks": [{
						"type": "suggestedInsert",
						"attrs": {"suggestionId": "s_open", "authorId": "uo_alice", "ts": 1700000001000}
					}]
				}]
			},
			{
				"type": "paragraph",
				"content": [{
					"type": "text",
					"text": "layered",
					"marks": [
						{"type": "suggestedDelete", "attrs": {"suggestionId": "s_bob", "authorId": "uo_bob", "ts": 1700000002000}},
						{"type": "suggestedDelete", "attrs": {"suggestionId": "s_carol", "authorId": "uo_carol", "ts": 1700000003000}}
					]
				}]
			}
		]
	}`)
	entries := []SuggestionMapEntry{
		{ID: "s_open", AuthorID: "uo_alice", CreatedAt: 1700000001000, Status: "open"},
		{ID: "s_bob", AuthorID: "uo_bob", CreatedAt: 1700000002000, Status: "open"},
		{ID: "s_carol", AuthorID: "uo_carol", CreatedAt: 1700000003000, Status: "open", Note: "i agree"},
	}

	docxBytes, warnings, err := PMJSONToDocxWithSuggestions(pmJSON, entries)
	if err != nil {
		t.Fatalf("PM→docx: %v", err)
	}
	if len(warnings) > 0 {
		t.Logf("warnings: %+v", warnings)
	}

	// 1. Confirm docx round-trip preserves the marks via the new
	//    DocxToPMJSONWithSuggestions entry point (which also returns
	//    the parsed entries from the customXml part).
	roundtripped, _, parsedEntries, err := DocxToPMJSONWithSuggestions(docxBytes)
	if err != nil {
		t.Fatalf("docx→PM: %v", err)
	}

	var doc PMNode
	if err := json.Unmarshal(roundtripped, &doc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	// Walk and count marks
	insertCount := 0
	deleteCount := 0
	for _, p := range doc.Content {
		for _, tn := range p.Content {
			for _, m := range tn.Marks {
				if m.Type == MarkTypeSuggestedInsert {
					insertCount++
				}
				if m.Type == MarkTypeSuggestedDelete {
					deleteCount++
				}
			}
		}
	}
	if insertCount != 1 {
		t.Errorf("expected 1 suggestedInsert mark, got %d", insertCount)
	}
	if deleteCount != 2 {
		t.Errorf("expected 2 layered suggestedDelete marks, got %d", deleteCount)
	}

	// 2. Confirm parsed entries match the originals
	if len(parsedEntries) != 3 {
		t.Fatalf("expected 3 parsed entries, got %d", len(parsedEntries))
	}
	byID := map[string]SuggestionMapEntry{}
	for _, e := range parsedEntries {
		byID[e.ID] = e
	}
	for _, want := range entries {
		got, ok := byID[want.ID]
		if !ok {
			t.Errorf("entry %q missing after roundtrip", want.ID)
			continue
		}
		if got.AuthorID != want.AuthorID {
			t.Errorf("entry %q: authorId got %q want %q", want.ID, got.AuthorID, want.AuthorID)
		}
		if got.Note != want.Note {
			t.Errorf("entry %q: note got %q want %q", want.ID, got.Note, want.Note)
		}
	}

	// 3. Confirm Word users would see this as track-changes:
	// document.xml has the expected <w:ins>/<w:del> wrapper counts.
	docXML := extractDocumentXMLForSuggestionTest(t, docxBytes)
	if strings.Count(string(docXML), "<w:ins ") != 1 {
		t.Errorf("expected 1 <w:ins> in document.xml")
	}
	if strings.Count(string(docXML), "<w:del ") != 2 {
		t.Errorf("expected 2 <w:del> in document.xml (Case 2c layered)")
	}
}
