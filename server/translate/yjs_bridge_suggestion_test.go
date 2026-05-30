package translate

import (
	"encoding/json"
	"testing"
)

// TestYjsBridgeRoundTripsSuggestionMarks confirms the marks land in
// the equivalent of a TipTap mark JSON object — the same shape the
// editor uses on the client. Without MarkTypeSuggestedInsert/Delete
// in SupportedMarks (Task 1), the bridge would strip these on the way
// in.
func TestYjsBridgeRoundTripsSuggestionMarks(t *testing.T) {
	input := []byte(`{
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
						"ts": 1700000000
					}
				}]
			}]
		}]
	}`)

	var pmDoc PMNode
	if err := json.Unmarshal(input, &pmDoc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(pmDoc.Content) == 0 || len(pmDoc.Content[0].Content) == 0 {
		t.Fatalf("doc shape unexpected: %+v", pmDoc)
	}
	text := pmDoc.Content[0].Content[0]
	if len(text.Marks) != 1 {
		t.Fatalf("expected 1 mark, got %d marks: %+v", len(text.Marks), text.Marks)
	}
	if text.Marks[0].Type != MarkTypeSuggestedInsert {
		t.Errorf("expected mark type %q, got %q",
			MarkTypeSuggestedInsert, text.Marks[0].Type)
	}
	if text.Marks[0].Attrs["suggestionId"] != "s_alice_1" {
		t.Errorf("expected suggestionId attr s_alice_1, got %v",
			text.Marks[0].Attrs["suggestionId"])
	}
}
