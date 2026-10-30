package translate

import (
	"strings"
	"testing"

	ycrdt "github.com/skyterra/y-crdt"
)

func paragraphDoc(text string) []byte {
	return []byte(`{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"` + text + `"}]}]}`)
}

func TestReplaceFromPMJSON_ReplacesTheWholeContent(t *testing.T) {
	doc := ycrdt.NewDoc("replace", false, nil, nil, false)
	if err := SeedFromPMJSON(doc, paragraphDoc("newer text")); err != nil {
		t.Fatal(err)
	}

	if err := ReplaceFromPMJSON(doc, paragraphDoc("older text")); err != nil {
		t.Fatal(err)
	}

	out, err := PMJSONFromYDoc(doc)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), "older text") || strings.Contains(string(out), "newer text") {
		t.Fatalf("doc = %s", out)
	}
}
