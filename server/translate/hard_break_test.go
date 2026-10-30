package translate

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	ycrdt "github.com/skyterra/y-crdt"
)

const hardBreakDoc = `{"type":"doc","content":[{"type":"paragraph","content":[` +
	`{"type":"text","text":"first line"},{"type":"hardBreak"},{"type":"text","text":"second line"}]}]}`

// The editor makes a hardBreak with Shift+Enter. A document holding one must
// save, and reopen with the break in the same place.
func TestHardBreak_RoundTripsThroughDocx(t *testing.T) {
	docx, err := PMJSONToDocx(context.Background(), []byte(hardBreakDoc))
	if err != nil {
		t.Fatalf("PMJSONToDocx: %v", err)
	}
	pm, _, err := DocxToPMJSON(context.Background(), docx)
	if err != nil {
		t.Fatalf("DocxToPMJSON: %v", err)
	}
	var root PMNode
	if err := json.Unmarshal(pm, &root); err != nil {
		t.Fatal(err)
	}
	para := root.Content[0]
	var types []string
	for _, c := range para.Content {
		types = append(types, c.Type)
	}
	if strings.Join(types, ",") != "text,hardBreak,text" {
		t.Fatalf("paragraph children = %v (%s)", types, pm)
	}
}

func TestHardBreak_RendersAsBr(t *testing.T) {
	html, err := PMJSONToHTML([]byte(hardBreakDoc), HTMLRenderOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(html, "first line<br>second line") {
		t.Fatalf("html = %s", html)
	}
}

func TestHardBreak_RoundTripsThroughYDoc(t *testing.T) {
	doc := ycrdt.NewDoc("hard-break", false, nil, nil, false)
	if err := SeedFromPMJSON(doc, []byte(hardBreakDoc)); err != nil {
		t.Fatal(err)
	}
	out, err := PMJSONFromYDoc(doc)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), `"type":"hardBreak"`) {
		t.Fatalf("doc = %s", out)
	}
}
