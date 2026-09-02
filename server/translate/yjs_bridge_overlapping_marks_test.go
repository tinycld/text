package translate

import (
	"encoding/json"
	"strings"
	"testing"

	ycrdt "github.com/skyterra/y-crdt"
)

// Regression: y-tiptap encodes "overlapping" marks (marks whose
// excludes set permits a same-type mark to coexist on the same
// range — suggestedDelete / suggestedInsert use excludes:” so two
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
//  1. switch to Suggesting mode
//  2. delete a run — the strikethrough decoration applies
//  3. reload the page
//  4. the strikethrough is gone and the text reads as a plain run
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

// Regression for the "trailing text vanished after mid-paragraph
// suggesting-mode delete" bug. y-tiptap stores a paragraph's inline
// content in a SINGLE YText that carries multiple format runs — e.g.
// a paragraph "prefix CUTME suffix" with a suggestedDelete mark on
// CUTME lives in Y.Doc as one YText whose delta has three insert ops
// (prefix / CUTME with mark / suffix). The Go decoder previously
// returned only the FIRST delta op as a single PMNode, silently
// dropping every later run from the PM JSON it produced. On flush
// the docx file then contained only "prefix " — both CUTME and the
// suffix were lost. After reload the editor saw exactly that:
// everything from the deleted word to the paragraph end was gone.
//
// This test pins the fix: a YText with multi-run formatting decodes
// into N PMNode-text entries, one per delta op.
func TestPMJSONFromYDoc_MultiRunFormattingDecodesAllRuns(t *testing.T) {
	doc := ycrdt.NewDoc("multi-run-room", false, nil, nil, false)
	if err := SeedFromPMJSON(doc, []byte(`{
		"type": "doc",
		"content": [{
			"type": "paragraph",
			"content": [{"type": "text", "text": "placeholder"}]
		}]
	}`)); err != nil {
		t.Fatalf("SeedFromPMJSON: %v", err)
	}

	// Reach into the seeded YText and rewrite its content so the
	// single YText carries the same three-run shape y-tiptap writes
	// for a "prefix [marked CUTME] suffix" paragraph. We delete the
	// placeholder content, then insert the three runs with their
	// respective format attributes (the middle run carrying the
	// hashed-key suggestedDelete attribute y-tiptap encodes).
	frag, _ := doc.GetXmlFragment("prosemirror").(*ycrdt.YXmlFragment)
	paraEl := frag.ToArray()[0].(*ycrdt.YXmlElement)
	yText := paraEl.YXmlFragment.ToArray()[0].(*ycrdt.YXmlText)
	yText.Delete(0, len("placeholder"))
	yText.Insert(0, "prefix ", nil)
	markAttrs := ycrdt.NewObject()
	markAttrs["suggestedDelete--AbCd1234"] = map[string]any{
		"suggestionId": "s_1",
		"authorId":     "uo_alice",
		"ts":           int64(1700000000),
	}
	yText.Insert(len("prefix "), "CUTME", markAttrs)
	clearAttrs := ycrdt.NewObject()
	clearAttrs["suggestedDelete--AbCd1234"] = nil
	yText.Insert(len("prefix CUTME"), " suffix", clearAttrs)

	got, err := PMJSONFromYDoc(doc)
	if err != nil {
		t.Fatalf("PMJSONFromYDoc: %v", err)
	}

	var parsed PMNode
	if err := json.Unmarshal(got, &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(parsed.Content) != 1 {
		t.Fatalf("expected 1 paragraph, got %d", len(parsed.Content))
	}
	textNodes := parsed.Content[0].Content
	if len(textNodes) != 3 {
		t.Fatalf("expected 3 text nodes (prefix, CUTME, suffix) after decoding multi-run YText, got %d. PM: %s",
			len(textNodes), got)
	}
	// All three text segments must survive — pre-fix the bug
	// silently dropped CUTME and " suffix" because the decoder
	// returned only the first delta op.
	if textNodes[0].Text != "prefix " {
		t.Errorf("text node 0: got %q, want %q", textNodes[0].Text, "prefix ")
	}
	if textNodes[1].Text != "CUTME" {
		t.Errorf("text node 1: got %q, want %q", textNodes[1].Text, "CUTME")
	}
	if textNodes[2].Text != " suffix" {
		t.Errorf("text node 2: got %q, want %q", textNodes[2].Text, " suffix")
	}
	// The middle node carries the suggestedDelete mark (hash-stripped
	// to its canonical name by the read-side normalization).
	if len(textNodes[1].Marks) != 1 || textNodes[1].Marks[0].Type != MarkTypeSuggestedDelete {
		t.Errorf("text node 1 should carry one suggestedDelete mark, got marks: %+v",
			textNodes[1].Marks)
	}
	// And the outer nodes carry no marks.
	if len(textNodes[0].Marks) != 0 {
		t.Errorf("text node 0 should have no marks, got: %+v", textNodes[0].Marks)
	}
	if len(textNodes[2].Marks) != 0 {
		t.Errorf("text node 2 should have no marks, got: %+v", textNodes[2].Marks)
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
	docxBytes, _, err := PMJSONToDocxWithSuggestions(t.Context(), roundtripped, nil)
	if err != nil {
		t.Fatalf("PMJSONToDocxWithSuggestions: %v", err)
	}
	docXML := extractDocumentXMLForSuggestionTest(t, docxBytes)
	if strings.Count(string(docXML), "<w:del ") != 1 {
		t.Errorf("expected 1 <w:del> in document.xml, got %d. docXML: %s",
			strings.Count(string(docXML), "<w:del "), string(docXML))
	}

	rtPM, _, _, err := DocxToPMJSONWithSuggestions(t.Context(), docxBytes)
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
