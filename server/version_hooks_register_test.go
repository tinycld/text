package text

import (
	"testing"

	"github.com/pocketbase/pocketbase/tests"
	"tinycld.org/core/versionhooks"
)

// Drive dispatches version hooks by drive_items.mime_type, so the hook must
// be registered under every MIME type Text edits.
func TestRegisterVersionHooks_CoversEveryEditableMime(t *testing.T) {
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)

	registerVersionHooks(app, &Runtime{})

	for _, mime := range []string{docxMimeType, rtfMimeType, rtfMimeTypeAlt} {
		hook := versionhooks.For(app, mime)
		if hook.OnSnapshot == nil || hook.Render == nil || hook.Diff == nil {
			t.Fatalf("no version hook for %s", mime)
		}
	}
}
