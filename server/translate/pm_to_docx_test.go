package translate

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestPMJSONToDocx_SinglePara generates a docx containing a single
// paragraph with one text run, then checks the output is a non-empty
// .docx and that round-tripping it through DocxToPMJSON recovers the
// original tree.
func TestPMJSONToDocx_SinglePara(t *testing.T) {
	original := PMNode{
		Type: NodeTypeDoc,
		Content: []PMNode{
			{
				Type: NodeTypeParagraph,
				Content: []PMNode{
					{Type: NodeTypeText, Text: "Hello, world!"},
				},
			},
		},
	}
	originalJSON, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	docxBytes, err := PMJSONToDocx(originalJSON)
	if err != nil {
		t.Fatalf("PMJSONToDocx: %v", err)
	}
	if len(docxBytes) < 100 {
		t.Fatalf("docx too small (%d bytes); probably empty", len(docxBytes))
	}

	parsedJSON, _, err := DocxToPMJSON(docxBytes)
	if err != nil {
		t.Fatalf("DocxToPMJSON of our own output: %v", err)
	}
	var parsed PMNode
	if err := json.Unmarshal(parsedJSON, &parsed); err != nil {
		t.Fatalf("unmarshal parsed: %v", err)
	}
	if len(parsed.Content) != 1 || parsed.Content[0].Type != NodeTypeParagraph {
		t.Fatalf("expected one paragraph, got: %+v", parsed)
	}
	paraContent := parsed.Content[0].Content
	if len(paraContent) != 1 || paraContent[0].Type != NodeTypeText {
		t.Fatalf("expected one text node, got: %+v", paraContent)
	}
	if paraContent[0].Text != "Hello, world!" {
		t.Errorf("text mismatch: got %q, want %q", paraContent[0].Text, "Hello, world!")
	}
}

// TestPMJSONToDocx_RichRoundTrip exercises all v1 features (marks,
// headings, lists, blockquote, table, hyperlink) in a single doc and
// verifies the round-trip preserves the structural identity.
func TestPMJSONToDocx_RichRoundTrip(t *testing.T) {
	original := PMNode{
		Type: NodeTypeDoc,
		Content: []PMNode{
			{
				Type:  NodeTypeHeading,
				Attrs: map[string]any{"level": float64(1)},
				Content: []PMNode{
					{Type: NodeTypeText, Text: "Title"},
				},
			},
			{
				Type: NodeTypeParagraph,
				Content: []PMNode{
					{Type: NodeTypeText, Text: "Plain "},
					{Type: NodeTypeText, Text: "bold", Marks: []PMMark{{Type: MarkTypeBold}}},
					{Type: NodeTypeText, Text: " "},
					{Type: NodeTypeText, Text: "italic", Marks: []PMMark{{Type: MarkTypeItalic}}},
					{Type: NodeTypeText, Text: " "},
					{Type: NodeTypeText, Text: "underline", Marks: []PMMark{{Type: MarkTypeUnderline}}},
					{Type: NodeTypeText, Text: " "},
					{
						Type: NodeTypeText,
						Text: "link",
						Marks: []PMMark{{
							Type:  MarkTypeLink,
							Attrs: map[string]any{"href": "https://example.com"},
						}},
					},
				},
			},
			{
				Type: NodeTypeBulletList,
				Content: []PMNode{
					{
						Type: NodeTypeListItem,
						Content: []PMNode{
							{Type: NodeTypeParagraph, Content: []PMNode{{Type: NodeTypeText, Text: "Item 1"}}},
						},
					},
					{
						Type: NodeTypeListItem,
						Content: []PMNode{
							{Type: NodeTypeParagraph, Content: []PMNode{{Type: NodeTypeText, Text: "Item 2"}}},
						},
					},
				},
			},
			{
				Type: NodeTypeOrderedList,
				Content: []PMNode{
					{
						Type: NodeTypeListItem,
						Content: []PMNode{
							{Type: NodeTypeParagraph, Content: []PMNode{{Type: NodeTypeText, Text: "First"}}},
						},
					},
					{
						Type: NodeTypeListItem,
						Content: []PMNode{
							{Type: NodeTypeParagraph, Content: []PMNode{{Type: NodeTypeText, Text: "Second"}}},
						},
					},
				},
			},
			{
				Type: NodeTypeBlockquote,
				Content: []PMNode{
					{Type: NodeTypeParagraph, Content: []PMNode{{Type: NodeTypeText, Text: "A quote"}}},
				},
			},
			{
				Type: NodeTypeTable,
				Content: []PMNode{
					{
						Type: NodeTypeTableRow,
						Content: []PMNode{
							{Type: NodeTypeTableCell, Content: []PMNode{
								{Type: NodeTypeParagraph, Content: []PMNode{{Type: NodeTypeText, Text: "A1"}}},
							}},
							{Type: NodeTypeTableCell, Content: []PMNode{
								{Type: NodeTypeParagraph, Content: []PMNode{{Type: NodeTypeText, Text: "B1"}}},
							}},
						},
					},
					{
						Type: NodeTypeTableRow,
						Content: []PMNode{
							{Type: NodeTypeTableCell, Content: []PMNode{
								{Type: NodeTypeParagraph, Content: []PMNode{{Type: NodeTypeText, Text: "A2"}}},
							}},
							{Type: NodeTypeTableCell, Content: []PMNode{
								{Type: NodeTypeParagraph, Content: []PMNode{{Type: NodeTypeText, Text: "B2"}}},
							}},
						},
					},
				},
			},
		},
	}
	originalJSON, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	docxBytes, err := PMJSONToDocx(originalJSON)
	if err != nil {
		t.Fatalf("PMJSONToDocx: %v", err)
	}
	parsedJSON, warnings, err := DocxToPMJSON(docxBytes)
	if err != nil {
		t.Fatalf("DocxToPMJSON: %v", err)
	}
	if len(warnings) > 0 {
		t.Errorf("unexpected warnings: %+v", warnings)
	}

	var parsed PMNode
	if err := json.Unmarshal(parsedJSON, &parsed); err != nil {
		t.Fatalf("unmarshal parsed: %v", err)
	}

	// Spot-check the expected shape.
	if len(parsed.Content) < 6 {
		t.Fatalf("expected >= 6 top-level children, got %d: %s", len(parsed.Content), parsedJSON)
	}
	want := []string{
		NodeTypeHeading, NodeTypeParagraph, NodeTypeBulletList,
		NodeTypeOrderedList, NodeTypeBlockquote, NodeTypeTable,
	}
	for i, w := range want {
		if parsed.Content[i].Type != w {
			t.Errorf("child %d: expected %s, got %s", i, w, parsed.Content[i].Type)
		}
	}

	// Verify the heading level survived.
	if lvl, ok := parsed.Content[0].Attrs["level"]; !ok {
		t.Errorf("heading missing level attr")
	} else if v, _ := lvl.(float64); v != 1 {
		t.Errorf("heading level: expected 1, got %v", lvl)
	}

	// Verify marks survived.
	paraRuns := parsed.Content[1].Content
	foundBold, foundItalic, foundUnderline, foundLink := false, false, false, false
	for _, r := range paraRuns {
		for _, m := range r.Marks {
			switch m.Type {
			case MarkTypeBold:
				if r.Text == "bold" {
					foundBold = true
				}
			case MarkTypeItalic:
				if r.Text == "italic" {
					foundItalic = true
				}
			case MarkTypeUnderline:
				if r.Text == "underline" {
					foundUnderline = true
				}
			case MarkTypeLink:
				if r.Text == "link" {
					foundLink = true
					if href, _ := m.Attrs["href"].(string); href != "https://example.com" {
						t.Errorf("link href mismatch: %q", href)
					}
				}
			}
		}
	}
	if !foundBold {
		t.Errorf("bold mark not preserved (paraRuns=%+v)", paraRuns)
	}
	if !foundItalic {
		t.Errorf("italic mark not preserved")
	}
	if !foundUnderline {
		t.Errorf("underline mark not preserved")
	}
	if !foundLink {
		t.Errorf("link mark not preserved")
	}

	// Verify list items survived as listItem children of bulletList /
	// orderedList — guards against a future regression where list-item
	// grouping silently breaks (every item gets its own list).
	bullet := parsed.Content[2]
	if got := len(bullet.Content); got != 2 {
		t.Errorf("bulletList: expected 2 items, got %d", got)
	}
	ordered := parsed.Content[3]
	if got := len(ordered.Content); got != 2 {
		t.Errorf("orderedList: expected 2 items, got %d", got)
	}

	// Blockquote should wrap one paragraph.
	bq := parsed.Content[4]
	if len(bq.Content) != 1 || bq.Content[0].Type != NodeTypeParagraph {
		t.Errorf("blockquote: expected one paragraph child, got %+v", bq.Content)
	}

	// Table should be 2x2 with the right cell text.
	tbl := parsed.Content[5]
	if got := len(tbl.Content); got != 2 {
		t.Fatalf("table: expected 2 rows, got %d", got)
	}
	expectedCells := [][]string{{"A1", "B1"}, {"A2", "B2"}}
	for r, row := range tbl.Content {
		if got := len(row.Content); got != 2 {
			t.Errorf("row %d: expected 2 cells, got %d", r, got)
			continue
		}
		for c, cell := range row.Content {
			// Cells may contain multiple paragraphs (WordZero seeds an
			// empty placeholder when a table is created); concatenate
			// the text of every text node in every paragraph child.
			var sb strings.Builder
			for _, para := range cell.Content {
				for _, run := range para.Content {
					if run.Type == NodeTypeText {
						sb.WriteString(run.Text)
					}
				}
			}
			if sb.String() != expectedCells[r][c] {
				t.Errorf("cell [%d][%d]: expected %q, got %q (full=%+v)", r, c, expectedCells[r][c], sb.String(), cell.Content)
			}
		}
	}
}
