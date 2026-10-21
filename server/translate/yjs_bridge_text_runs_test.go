package translate

import (
	"encoding/json"
	"testing"

	ycrdt "github.com/skyterra/y-crdt"
)

// The client binding (y-tiptap) matches editor children to Y children one to
// one: each run of adjacent text nodes is ONE YXmlText and every other node a
// YXmlElement. A seed that splits a run across several YXmlTexts makes the
// binding refuse every edit, so the seed must build the same shape.
func TestSeedFromPMJSON_AdjacentTextIsOneXmlText(t *testing.T) {
	original := PMNode{
		Type: NodeTypeDoc,
		Content: []PMNode{{
			Type: NodeTypeParagraph,
			Content: []PMNode{
				{Type: NodeTypeText, Text: "bold", Marks: []PMMark{{Type: MarkTypeBold}}},
				{Type: NodeTypeText, Text: " plain"},
				{Type: NodeTypePageBreak},
				{Type: NodeTypeText, Text: "after"},
			},
		}},
	}
	originalJSON, err := json.Marshal(original)
	if err != nil {
		t.Fatal(err)
	}
	doc := ycrdt.NewDoc("test-room", false, nil, nil, false)
	if err := SeedFromPMJSON(doc, originalJSON); err != nil {
		t.Fatalf("SeedFromPMJSON: %v", err)
	}

	frag := doc.GetXmlFragment(xmlFragmentName).(*ycrdt.YXmlFragment)
	para := frag.ToArray()[0].(*ycrdt.YXmlElement)
	children := para.ToArray()
	if len(children) != 3 {
		t.Fatalf("paragraph has %d Y children, want 3 (text run, pageBreak, text run)", len(children))
	}
	first, ok := children[0].(*ycrdt.YXmlText)
	if !ok {
		t.Fatalf("child 0 is %T, want *YXmlText", children[0])
	}
	if el, ok := children[1].(*ycrdt.YXmlElement); !ok || el.NodeName != NodeTypePageBreak {
		t.Fatalf("child 1 is %T, want the pageBreak element", children[1])
	}
	if _, ok := children[2].(*ycrdt.YXmlText); !ok {
		t.Fatalf("child 2 is %T, want *YXmlText", children[2])
	}

	// The plain part must not take on the bold before it.
	delta := first.ToDelta(nil, nil, nil)
	if len(delta) != 2 {
		t.Fatalf("first run delta has %d ops, want 2: %+v", len(delta), delta)
	}
	if _, bold := delta[1].Attributes[MarkTypeBold]; bold {
		t.Fatalf("plain text after bold is bold: %+v", delta[1])
	}

	roundTripped, err := PMJSONFromYDoc(doc)
	if err != nil {
		t.Fatal(err)
	}
	var originalParsed, rtParsed PMNode
	_ = json.Unmarshal(originalJSON, &originalParsed)
	_ = json.Unmarshal(roundTripped, &rtParsed)
	want, _ := json.Marshal(originalParsed)
	got, _ := json.Marshal(rtParsed)
	if string(want) != string(got) {
		t.Errorf("round-trip mismatch:\nwant: %s\ngot:  %s", want, got)
	}
}
