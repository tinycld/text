package translate

import (
	"encoding/json"
	"strings"
	"testing"

	ycrdt "github.com/skyterra/y-crdt"
)

// Regression: y-tiptap encodes "overlapping" marks (marks whose
// excludes set permits a same-type mark to coexist on the same
// range — suggestedDelete / suggestedInsert use excludes:'' so two
// authors can independently propose the same edit) under a HASHED
// attribute key on the YText: `${mark.type.name}--${hashOfJSON(json)}`.
//
// The regex y-tiptap uses on decode is /(.*)(--[a-zA-Z0-9+/=]{8})$/,
// which strips the hash suffix back to the canonical mark name. The
// JS round-trip therefore preserves the mark unchanged.
//
// The Go-side yjs bridge was decoding these attribute keys verbatim,
// emitting PM marks of type "suggestedDelete--abcdef12" — a name no
// downstream emitter recognizes. The docx emitter then SILENTLY
// dropped the mark (queueSuggestionMarks's default branch is
// `continue`), so the on-disk .docx had no <w:del> wrapper around
// the deleted run. On the next room open the bootstrap re-parsed
// the .docx and produced an unmarked run — the strikethrough that
// the user saw in-session was gone, even though the underlying text
// survived.
//
// User-visible bug:
//   1. switch to Suggesting mode
//   2. delete a run — the strikethrough decoration applies
//   3. reload the page
//   4. the strikethrough is gone and the text reads as a plain run
//
// This test exercises the exact path that breaks: build a YText
// whose only mark is stored under the hashed key (i.e. exactly what
// y-tiptap writes when the client commits a suggestedDelete), call
// PMJSONFromYDoc, and assert the resulting PM mark carries the
// canonical type name.
func TestPMJSONFromYDoc_StripsYTiptapHashSuffixOnMarkKey(t *testing.T) {
	doc := ycrdt.NewDoc("hash-strip-room", false, nil, nil, false)

	// Seed via the bridge with a `suggestedDelete--<hash>` attribute
	// key directly — exactly the shape y-tiptap writes for an
	// overlapping mark. We use SeedFromPMJSON's machinery indirectly
	// by writing a minimal paragraph manually, then poke a YText at
	// the right position with the hashed-key format attribute.
	pmJSON := []byte(`{
		"type": "doc",
		"content": [{
			"type": "paragraph",
			"content": [{"type": "text", "text": "delete-me"}]
		}]
	}`)
	if err := SeedFromPMJSON(doc, pmJSON); err != nil {
		t.Fatalf("SeedFromPMJSON: %v", err)
	}

	// Reach into the seeded fragment and apply the hashed-key format
	// attribute that y-tiptap would write. The hash suffix is exactly
	// 8 base64 chars (6 bytes via _convolute) per y-tiptap's encoder.
	frag, ok := doc.GetXmlFragment("prosemirror").(*ycrdt.YXmlFragment)
	if !ok {
		t.Fatalf("GetXmlFragment did not return *YXmlFragment")
	}
	items := frag.ToArray()
	if len(items) != 1 {
		t.Fatalf("expected 1 fragment child, got %d", len(items))
	}
	paraEl, ok := items[0].(*ycrdt.YXmlElement)
	if !ok {
		t.Fatalf("expected first child to be *YXmlElement, got %T", items[0])
	}
	paraItems := paraEl.YXmlFragment.ToArray()
	if len(paraItems) != 1 {
		t.Fatalf("expected 1 paragraph child, got %d", len(paraItems))
	}
	yText, ok := paraItems[0].(*ycrdt.YXmlText)
	if !ok {
		t.Fatalf("expected paragraph child to be *YXmlText, got %T", paraItems[0])
	}
	// Apply the hashed-key format attribute. The KEY here is the
	// canonical y-tiptap shape: <mark-name>--<8 base64 chars>.
	attrs := ycrdt.NewObject()
	attrs["suggestedDelete--AbCdEf12"] = map[string]any{
		"suggestionId": "s_1",
		"authorId":     "uo_alice",
		"ts":           int64(1700000000),
	}
	yText.Format(0, len("delete-me"), attrs)

	got, err := PMJSONFromYDoc(doc)
	if err != nil {
		t.Fatalf("PMJSONFromYDoc: %v", err)
	}

	var parsed PMNode
	if err := json.Unmarshal(got, &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(parsed.Content) != 1 || len(parsed.Content[0].Content) != 1 {
		t.Fatalf("unexpected shape: %s", got)
	}
	text := parsed.Content[0].Content[0]
	if len(text.Marks) != 1 {
		t.Fatalf("expected 1 mark, got %d: %s", len(text.Marks), got)
	}
	// The fix: the bridge canonicalises the hashed key back to the
	// bare mark name so downstream code (docx emitter, comment
	// extractor, etc.) sees the canonical type.
	if text.Marks[0].Type != MarkTypeSuggestedDelete {
		t.Errorf("expected mark type %q after hash strip, got %q (full JSON: %s)",
			MarkTypeSuggestedDelete, text.Marks[0].Type, got)
	}
}

// Companion regression: the full path the live editor exercises —
// PMJSONFromYDoc with a hashed key -> PMJSONToDocxWithSuggestions ->
// DocxToPMJSONWithSuggestions — must surface the suggestedDelete mark
// throughout. Before the fix the docx emitter saw an unknown
// "suggestedDelete--..." mark and dropped it, so the resulting .docx
// had no <w:del>, the parse-back produced no mark, and the live
// strikethrough vanished on reload.
func TestPMJSONFromYDoc_DocxRoundTripPreservesHashedMark(t *testing.T) {
	doc := ycrdt.NewDoc("hash-strip-docx-room", false, nil, nil, false)
	pmJSON := []byte(`{
		"type": "doc",
		"content": [{
			"type": "paragraph",
			"content": [{"type": "text", "text": "delete-me"}]
		}]
	}`)
	if err := SeedFromPMJSON(doc, pmJSON); err != nil {
		t.Fatalf("SeedFromPMJSON: %v", err)
	}
	frag, _ := doc.GetXmlFragment("prosemirror").(*ycrdt.YXmlFragment)
	paraEl := frag.ToArray()[0].(*ycrdt.YXmlElement)
	yText := paraEl.YXmlFragment.ToArray()[0].(*ycrdt.YXmlText)
	attrs := ycrdt.NewObject()
	attrs["suggestedDelete--XyZw1234"] = map[string]any{
		"suggestionId": "s_1",
		"authorId":     "uo_alice",
		"ts":           int64(1700000000),
	}
	yText.Format(0, len("delete-me"), attrs)

	roundtripped, err := PMJSONFromYDoc(doc)
	if err != nil {
		t.Fatalf("PMJSONFromYDoc: %v", err)
	}
	docxBytes, _, err := PMJSONToDocxWithSuggestions(roundtripped, nil)
	if err != nil {
		t.Fatalf("PMJSONToDocxWithSuggestions: %v", err)
	}
	docXML := extractDocumentXMLForSuggestionTest(t, docxBytes)
	if strings.Count(string(docXML), "<w:del ") != 1 {
		t.Errorf("expected 1 <w:del> in document.xml, got %d. docXML: %s",
			strings.Count(string(docXML), "<w:del "), string(docXML))
	}

	rtPM, _, _, err := DocxToPMJSONWithSuggestions(docxBytes)
	if err != nil {
		t.Fatalf("DocxToPMJSONWithSuggestions: %v", err)
	}
	var doc2 PMNode
	if err := json.Unmarshal(rtPM, &doc2); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	deleteCount := 0
	for _, p := range doc2.Content {
		for _, tn := range p.Content {
			for _, m := range tn.Marks {
				if m.Type == MarkTypeSuggestedDelete {
					deleteCount++
				}
			}
		}
	}
	if deleteCount != 1 {
		t.Errorf("expected 1 suggestedDelete mark after docx roundtrip, got %d. PM: %s",
			deleteCount, rtPM)
	}
}
