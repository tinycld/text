package text

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"tinycld.org/packages/text/translate"
)

// docxWithText builds a one-paragraph docx through the real PM → docx path.
func docxWithText(t *testing.T, text string) []byte {
	t.Helper()
	pm := fmt.Sprintf(`{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":%q}]}]}`, text)
	b, err := translate.PMJSONToDocx(context.Background(), []byte(pm))
	if err != nil {
		t.Fatalf("PMJSONToDocx: %v", err)
	}
	return b
}

// seedDocxRecord makes a drive_items row holding a docx with text. The
// text test app has no drive_item_versions collection; a version row has
// the same `file` and `mime_type` fields, so a drive_items row stands in.
func seedDocxRecord(t *testing.T, app *tests.TestApp, name, text string) *core.Record {
	t.Helper()
	rec := seedDriveItem(t, app, name, docxWithText(t, text))
	rec.Set("mime_type", docxMimeType)
	if err := app.Save(rec); err != nil {
		t.Fatal(err)
	}
	return rec
}

func TestRenderVersion_RendersTheVersionNotTheItem(t *testing.T) {
	app := setupTestApp(t)
	item := seedDocxRecord(t, app, "current.docx", "v2 text")
	version := seedDocxRecord(t, app, "older.docx", "v1 text")

	html, err := renderVersion(context.Background(), app, item, version, "")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(html, "v1 text") || strings.Contains(html, "v2 text") {
		t.Fatalf("html = %q", html)
	}
}

func TestDiffVersions_MarksWordChanges(t *testing.T) {
	app := setupTestApp(t)
	item := seedDocxRecord(t, app, "item.docx", "alpha gamma delta")
	from := seedDocxRecord(t, app, "from.docx", "alpha beta delta")
	to := seedDocxRecord(t, app, "to.docx", "alpha gamma delta")

	html, err := diffVersions(context.Background(), app, item, from, to, "")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(html, "<del>beta</del>") || !strings.Contains(html, "<ins>gamma</ins>") {
		t.Fatalf("html = %q", html)
	}
}

func TestDiffVersions_NoFromMarksAllInserted(t *testing.T) {
	app := setupTestApp(t)
	item := seedDocxRecord(t, app, "item.docx", "first")
	to := seedDocxRecord(t, app, "to.docx", "first")

	html, err := diffVersions(context.Background(), app, item, nil, to, "")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(html, `data-diff="ins"`) {
		t.Fatalf("html = %q", html)
	}
}
