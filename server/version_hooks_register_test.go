package text

import (
	"testing"

	"tinycld.org/core/versionhooks"
)

// Drive dispatches version hooks by drive_items.mime_type, so the hook must
// be registered under every MIME type Text edits.
func TestRegisterVersionHooks_CoversEveryEditableMime(t *testing.T) {
	t.Cleanup(versionhooks.ResetForTest)
	versionhooks.ResetForTest()

	registerVersionHooks(&Runtime{})

	for _, mime := range []string{docxMimeType, rtfMimeType, rtfMimeTypeAlt} {
		hook := versionhooks.For(mime)
		if hook.OnSnapshot == nil || hook.OnRestore == nil || hook.Render == nil || hook.Diff == nil {
			t.Fatalf("no version hook for %s", mime)
		}
	}
}
