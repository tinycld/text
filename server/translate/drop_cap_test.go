package translate

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

// mustBuildDocxFromBody wraps a raw <w:body> inner-XML string in the
// minimum file set DocxToPMJSON needs ([Content_Types].xml, root rels,
// word/document.xml) and returns the zipped bytes. Used by the drop-cap
// import tests to feed exact OOXML shapes (framePr frames, flattened
// cap+body pairs) the emitter never produces itself.
func mustBuildDocxFromBody(t *testing.T, bodyXML string) []byte {
	t.Helper()
	docXML := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
		`<w:body>` + bodyXML + `</w:body></w:document>`
	contentTypes := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
		`<Default Extension="xml" ContentType="application/xml"/>` +
		`<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
		`<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
		`</Types>`
	rootRels := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
		`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
		`</Relationships>`
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, f := range []struct{ name, body string }{
		{"[Content_Types].xml", contentTypes},
		{"_rels/.rels", rootRels},
		{"word/document.xml", docXML},
	} {
		w, err := zw.Create(f.name)
		if err != nil {
			t.Fatalf("zip create %q: %v", f.name, err)
		}
		if _, err := w.Write([]byte(f.body)); err != nil {
			t.Fatalf("zip write %q: %v", f.name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	return buf.Bytes()
}

func mustParseBody(t *testing.T, bodyXML string) PMNode {
	t.Helper()
	pmJSON, _, err := DocxToPMJSON(t.Context(), mustBuildDocxFromBody(t, bodyXML))
	if err != nil {
		t.Fatalf("DocxToPMJSON: %v", err)
	}
	var root PMNode
	if err := json.Unmarshal(pmJSON, &root); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return root
}

// firstParagraphText concatenates all text-run content of a paragraph.
func paragraphText(n PMNode) string {
	var sb strings.Builder
	for _, c := range n.Content {
		if c.Type == NodeTypeText {
			sb.WriteString(c.Text)
		}
	}
	return sb.String()
}

// TestDocxToPM_LegacyDropCap_Merged verifies the strict legacy heuristic
// folds a flattened cap+body pair (a single large-font letter paragraph
// followed by a paragraph starting mid-word) into one dropCap paragraph,
// with the cap run's oversized fontSize stripped and the word reassembled.
func TestDocxToPM_LegacyDropCap_Merged(t *testing.T) {
	body := `<w:p><w:r><w:rPr><w:sz w:val="120"/></w:rPr><w:t>D</w:t></w:r></w:p>` +
		`<w:p><w:r><w:t xml:space="preserve">ropcaps wrap around the cap.</w:t></w:r></w:p>`
	root := mustParseBody(t, body)

	if len(root.Content) != 1 {
		t.Fatalf("expected 1 merged block, got %d", len(root.Content))
	}
	p := root.Content[0]
	if p.Type != NodeTypeParagraph {
		t.Fatalf("expected paragraph, got %q", p.Type)
	}
	if dc, _ := p.Attrs["dropCap"].(bool); !dc {
		t.Errorf("expected dropCap=true, got attrs %+v", p.Attrs)
	}
	if got, want := paragraphText(p), "Dropcaps wrap around the cap."; got != want {
		t.Errorf("reassembled text = %q, want %q", got, want)
	}
	// The cap run must no longer carry the oversized fontSize.
	if len(p.Content) == 0 || p.Content[0].Text != "D" {
		t.Fatalf("expected first run to be the cap 'D', got %+v", p.Content)
	}
	if runFontSizePx(p.Content[0]) != 0 {
		t.Errorf("cap run still carries a fontSize: %+v", p.Content[0].Marks)
	}
}

// TestDocxToPM_NativeFramePrDropCap verifies a Word-native drop cap (cap
// alone in a framePr frame paragraph + body paragraph) merges into one
// dropCap paragraph regardless of font size / case (Word already told us
// it's a drop cap via framePr).
func TestDocxToPM_NativeFramePrDropCap(t *testing.T) {
	body := `<w:p><w:pPr><w:framePr w:dropCap="drop" w:lines="3"/></w:pPr>` +
		`<w:r><w:t>D</w:t></w:r></w:p>` +
		`<w:p><w:r><w:t xml:space="preserve">ropcap via framePr.</w:t></w:r></w:p>`
	root := mustParseBody(t, body)

	if len(root.Content) != 1 {
		t.Fatalf("expected 1 merged block, got %d", len(root.Content))
	}
	p := root.Content[0]
	if dc, _ := p.Attrs["dropCap"].(bool); !dc {
		t.Errorf("expected dropCap=true, got attrs %+v", p.Attrs)
	}
	if _, leaked := p.Attrs["_dropCapFrame"]; leaked {
		t.Errorf("internal _dropCapFrame marker leaked into output: %+v", p.Attrs)
	}
	if got, want := paragraphText(p), "Dropcap via framePr."; got != want {
		t.Errorf("reassembled text = %q, want %q", got, want)
	}
}

// TestDocxToPM_NotADropCap_NoMerge guards the strict heuristic against
// false positives: a large single-letter paragraph followed by a normal
// sentence (capitalized, with a leading space) must NOT be merged.
func TestDocxToPM_NotADropCap_NoMerge(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{
			// Next paragraph starts with a capital — a new sentence, not
			// a mid-word continuation.
			name: "capitalized continuation",
			body: `<w:p><w:r><w:rPr><w:sz w:val="120"/></w:rPr><w:t>A</w:t></w:r></w:p>` +
				`<w:p><w:r><w:t xml:space="preserve">Normal paragraph.</w:t></w:r></w:p>`,
		},
		{
			// Cap-sized letter but next paragraph starts with a space.
			name: "leading space continuation",
			body: `<w:p><w:r><w:rPr><w:sz w:val="120"/></w:rPr><w:t>A</w:t></w:r></w:p>` +
				`<w:p><w:r><w:t xml:space="preserve"> already spaced.</w:t></w:r></w:p>`,
		},
		{
			// Single letter but ordinary (small) font — not a cap.
			name: "small font letter",
			body: `<w:p><w:r><w:t>D</w:t></w:r></w:p>` +
				`<w:p><w:r><w:t xml:space="preserve">ropcap-looking but tiny.</w:t></w:r></w:p>`,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			root := mustParseBody(t, c.body)
			if len(root.Content) != 2 {
				t.Fatalf("expected 2 unmerged blocks, got %d", len(root.Content))
			}
			for i, b := range root.Content {
				if dc, _ := b.Attrs["dropCap"].(bool); dc {
					t.Errorf("block %d unexpectedly merged to dropCap: %+v", i, b.Attrs)
				}
			}
		})
	}
}

// TestPMJSONToDocx_DropCapFramePrSplit verifies export splits a dropCap
// paragraph into Word's native two-paragraph form: a cap paragraph
// carrying <w:framePr w:dropCap="drop" w:lines="3"/> + a body paragraph.
func TestPMJSONToDocx_DropCapFramePrSplit(t *testing.T) {
	original := PMNode{
		Type: NodeTypeDoc,
		Content: []PMNode{
			{
				Type:  NodeTypeParagraph,
				Attrs: map[string]any{"dropCap": true},
				Content: []PMNode{
					{Type: NodeTypeText, Text: "Dropcaps wrap around the cap."},
				},
			},
		},
	}
	originalJSON, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	docxBytes, err := PMJSONToDocx(t.Context(), originalJSON)
	if err != nil {
		t.Fatalf("PMJSONToDocx: %v", err)
	}
	doc := string(readDocxPart(t, docxBytes, "word/document.xml"))

	if !strings.Contains(doc, `<w:framePr w:dropCap="drop" w:lines="3"/>`) {
		t.Errorf("expected framePr drop cap in output, got:\n%s", doc)
	}
	// The marker token must be fully stripped (no internal {{__pmdc:…}}).
	if strings.Contains(doc, "__pmdc") {
		t.Errorf("drop-cap marker token leaked into output:\n%s", doc)
	}
	// Cap "D" and the remainder "ropcaps…" both survive.
	if !strings.Contains(doc, ">D</w:t>") {
		t.Errorf("cap letter run missing:\n%s", doc)
	}
	if !strings.Contains(doc, "ropcaps wrap around the cap.") {
		t.Errorf("body remainder missing:\n%s", doc)
	}
}

// TestDropCap_RoundTrip verifies a dropCap paragraph survives the full
// feature → docx → feature cycle via the native framePr path (NOT the
// legacy heuristic): export splits to framePr, import merges back.
func TestDropCap_RoundTrip(t *testing.T) {
	original := PMNode{
		Type: NodeTypeDoc,
		Content: []PMNode{
			{
				Type:  NodeTypeParagraph,
				Attrs: map[string]any{"dropCap": true},
				Content: []PMNode{
					{Type: NodeTypeText, Text: "Dropcaps wrap around the cap and reflow."},
				},
			},
		},
	}
	parsed := mustRoundtripParagraph(t, original)
	if len(parsed.Content) != 1 {
		t.Fatalf("expected 1 block after round-trip, got %d", len(parsed.Content))
	}
	p := parsed.Content[0]
	if dc, _ := p.Attrs["dropCap"].(bool); !dc {
		t.Errorf("dropCap lost on round-trip, attrs %+v", p.Attrs)
	}
	if got, want := paragraphText(p), "Dropcaps wrap around the cap and reflow."; got != want {
		t.Errorf("round-trip text = %q, want %q", got, want)
	}
}

// TestPMJSONToHTML_DropCapClass verifies the HTML renderer tags a dropCap
// paragraph with the tinycld-text-p-drop-cap class (and a normal
// paragraph does not).
func TestPMJSONToHTML_DropCapClass(t *testing.T) {
	doc := PMNode{
		Type: NodeTypeDoc,
		Content: []PMNode{
			{
				Type:    NodeTypeParagraph,
				Attrs:   map[string]any{"dropCap": true},
				Content: []PMNode{{Type: NodeTypeText, Text: "Dropcap paragraph."}},
			},
			{
				Type:    NodeTypeParagraph,
				Content: []PMNode{{Type: NodeTypeText, Text: "Normal paragraph."}},
			},
		},
	}
	jsonBytes, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	html, err := PMJSONToHTML(jsonBytes, HTMLRenderOpts{})
	if err != nil {
		t.Fatalf("PMJSONToHTML: %v", err)
	}
	if !strings.Contains(html, "tinycld-text-p-drop-cap") {
		t.Errorf("expected drop-cap class in HTML, got:\n%s", html)
	}
	// The normal paragraph must not get the class — count occurrences.
	if n := strings.Count(html, "tinycld-text-p-drop-cap"); n != 1 {
		t.Errorf("expected exactly 1 drop-cap class, got %d:\n%s", n, html)
	}
}
