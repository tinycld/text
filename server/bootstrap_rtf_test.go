package text

import (
	"os"
	"path/filepath"
	"testing"
)

// TestBootstrap_LoadsRTF drives the full production bootstrap chain on an
// RTF-sourced drive_item: read bytes -> sourceBytesToDocx (RTF->DOCX) ->
// DocxToPMJSONWithSuggestions -> seed Y.Doc. Mirrors TestBootstrap_LoadsAndSeeds
// but with an RTF blob + RTF mime, so it exercises the bridge added for RTF
// support. A non-trivial Y.Doc state proves the content survived end to end.
func TestBootstrap_LoadsRTF(t *testing.T) {
	app := setupTestApp(t)

	rtf, err := os.ReadFile(filepath.Join("..", "tests", "assets", "sample.rtf"))
	if err != nil {
		t.Fatalf("read rtf fixture: %v", err)
	}
	item := seedDriveItem(t, app, "sample.rtf", rtf)
	item.Set("mime_type", rtfMimeType)
	if err := app.Save(item); err != nil {
		t.Fatalf("set rtf mime: %v", err)
	}

	runtime := NewRuntime()
	runtime.SetBootstrap(makeDocxBootstrap(app, runtime))

	handle, err := runtime.NewDoc(item.Id)
	if err != nil {
		t.Fatalf("NewDoc on rtf item: %v", err)
	}
	defer func() { _ = handle.Close() }()

	state, err := handle.EncodeStateAsUpdate()
	if err != nil {
		t.Fatalf("EncodeStateAsUpdate: %v", err)
	}
	if len(state) < 100 {
		t.Errorf("Y.Doc looks empty after RTF bootstrap (state size %d); expected > 100", len(state))
	}
}
