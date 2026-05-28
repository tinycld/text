package translate

import "testing"

func TestQueueSuggestionMarksProducesOneSpanPerMark(t *testing.T) {
	em := newEmitter()
	marks := []PMMark{
		{
			Type: MarkTypeSuggestedInsert,
			Attrs: map[string]any{
				"suggestionId": "s_alice_1",
				"authorId":     "uo_alice",
				"ts":           float64(1700000000),
			},
		},
		{
			Type: MarkTypeBold,
		},
	}
	spans := em.queueSuggestionMarks(marks)
	if len(spans) != 1 {
		t.Fatalf("expected 1 span, got %d", len(spans))
	}
	if spans[0].Kind != suggestionKindInsert {
		t.Errorf("expected kind insert, got %v", spans[0].Kind)
	}
	if spans[0].SuggestionID != "s_alice_1" {
		t.Errorf("expected suggestionId s_alice_1, got %q", spans[0].SuggestionID)
	}
	if spans[0].AuthorID != "uo_alice" {
		t.Errorf("expected authorId uo_alice, got %q", spans[0].AuthorID)
	}
	if spans[0].DocxRevisionID == 0 {
		t.Errorf("expected non-zero DocxRevisionID, got 0")
	}
}

func TestQueueSuggestionMarksProducesTwoSpansForLayeredMarks(t *testing.T) {
	em := newEmitter()
	// Case 2c: two users propose deletion of the same range.
	marks := []PMMark{
		{
			Type: MarkTypeSuggestedDelete,
			Attrs: map[string]any{
				"suggestionId": "s_bob",
				"authorId":     "uo_bob",
				"ts":           float64(1700000000),
			},
		},
		{
			Type: MarkTypeSuggestedDelete,
			Attrs: map[string]any{
				"suggestionId": "s_carol",
				"authorId":     "uo_carol",
				"ts":           float64(1700000100),
			},
		},
	}
	spans := em.queueSuggestionMarks(marks)
	if len(spans) != 2 {
		t.Fatalf("expected 2 spans, got %d", len(spans))
	}
	for _, s := range spans {
		if s.Kind != suggestionKindDelete {
			t.Errorf("expected both spans to be delete kind, got %v", s.Kind)
		}
	}
	if spans[0].DocxRevisionID == spans[1].DocxRevisionID {
		t.Errorf("expected distinct DocxRevisionIDs, got %d twice",
			spans[0].DocxRevisionID)
	}
}

func TestQueueSuggestionMarksIgnoresNonSuggestionMarks(t *testing.T) {
	em := newEmitter()
	marks := []PMMark{
		{Type: MarkTypeBold},
		{Type: MarkTypeItalic},
		{Type: MarkTypeComment, Attrs: map[string]any{"commentId": "c1"}},
	}
	spans := em.queueSuggestionMarks(marks)
	if len(spans) != 0 {
		t.Errorf("expected 0 spans for non-suggestion marks, got %d", len(spans))
	}
}
