package text

import (
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"
	ycrdt "github.com/skyterra/y-crdt"

	driveserver "tinycld.org/packages/drive"
)

// versionStateFilename is the on-disk filename used when storing the
// snapshot's Yjs state as a drive_item_versions.yjs_state file. The file
// is opaque binary (yjs update v1 encoding); the .bin suffix exists
// purely so a curious operator inspecting the storage bucket recognizes
// it as non-text. PocketBase prepends its own random prefix so two
// versions never collide on the same key.
const versionStateFilename = "yjs_state.bin"

// makeSnapshotVersionHook returns the drive VersionHook that captures
// the live server doc's Yjs state into drive_item_versions.yjs_state +
// drive_item_versions.version_metadata on snapshot. The OnRestore
// implementation is added in Task 5; for now the field is left nil so
// drive's existing docx-only restore continues to run unaltered.
//
// OnSnapshot gracefully no-ops when the room isn't live — a text doc
// whose collaboration session has been evicted from memory (or never
// opened) has no in-memory Y.Doc to capture from. The docx round-trip
// (which drive owns) still works for the content; only the protected
// roots (clientAuthors / clientFirstSeen / editEvents) are lost in
// that case.
func makeSnapshotVersionHook(runtime *Runtime) driveserver.VersionHook {
	return driveserver.VersionHook{
		OnSnapshot: makeSnapshotVersionHookFn(runtime),
	}
}

// makeSnapshotVersionHookFn returns the OnSnapshot implementation.
// Looks up the live handle for the item's room, captures Yjs state +
// metadata under the handle mutex, and writes both back into the
// version row. Best-effort: a missing handle returns nil (no Phase 4
// data on this version is acceptable per design).
func makeSnapshotVersionHookFn(runtime *Runtime) func(core.App, *core.Record, *core.Record) error {
	return func(app core.App, item *core.Record, version *core.Record) error {
		handle := runtime.handleFor(item.Id)
		if handle == nil {
			slog.Info("text: snapshot room not live; yjs_state not captured",
				"itemID", item.Id, "versionID", version.Id)
			return nil
		}
		stateBytes, metadataJSON, err := captureYjsStateAndMetadata(handle)
		if err != nil {
			return fmt.Errorf("text: snapshot capture: %w", err)
		}
		stateFile, err := filesystem.NewFileFromBytes(stateBytes, versionStateFilename)
		if err != nil {
			return fmt.Errorf("text: snapshot wrap yjs_state: %w", err)
		}
		version.Set("yjs_state", stateFile)
		version.Set("version_metadata", string(metadataJSON))
		if err := app.Save(version); err != nil {
			return fmt.Errorf("text: snapshot save version: %w", err)
		}
		return nil
	}
}

// captureYjsStateAndMetadata reads the live doc under h.mu and returns
// the encoded full state + computed metadata JSON. The mutex covers both
// reads so a concurrent ApplyUpdate / stampAuthorship can't slip an edit
// between the state encode and the metadata walk.
func captureYjsStateAndMetadata(h *textDocHandle) ([]byte, []byte, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed || h.doc == nil {
		return nil, nil, fmt.Errorf("text: handle closed during snapshot")
	}
	state := ycrdt.EncodeStateAsUpdate(h.doc, nil)
	metadata := computeMetadata(h.doc)
	js, err := json.Marshal(metadata)
	if err != nil {
		return nil, nil, fmt.Errorf("marshal metadata: %w", err)
	}
	return state, js, nil
}

// versionMetadata is the wire shape persisted into
// drive_item_versions.version_metadata. SchemaVersion lets a future
// migration distinguish v1 payloads from a hypothetical v2 (e.g. one
// that adds resolved-suggestion stats); bump on incompatible additions.
type versionMetadata struct {
	SuggestionsOpen int      `json:"suggestionsOpen"`
	Authors         []string `json:"authors"`
	SchemaVersion   int      `json:"schemaVersion"`
}

// computeMetadata walks the doc's suggestions Y.Map and clientAuthors
// Y.Map to build the metadata struct. Treats the Authors slice as a
// set (deduplicated) and counts only suggestions whose status === "open".
//
// Returns Authors as a non-nil empty slice (`[]`) when the doc carries
// no clientAuthors so the JSON marshal emits `"authors": []` instead
// of `"authors": null`, keeping the client decoder branchless.
func computeMetadata(doc *ycrdt.Doc) versionMetadata {
	out := versionMetadata{SchemaVersion: 1, Authors: []string{}}
	if sm, ok := doc.GetMap("suggestions").(*ycrdt.YMap); ok && sm != nil {
		for _, v := range sm.Entries() {
			m, ok := v.(map[string]any)
			if !ok {
				continue
			}
			status, _ := m["status"].(string)
			if status == "open" {
				out.SuggestionsOpen++
			}
		}
	}
	if ca, ok := doc.GetMap("clientAuthors").(*ycrdt.YMap); ok && ca != nil {
		seen := map[string]bool{}
		for _, v := range ca.Entries() {
			s, ok := v.(string)
			if !ok || s == "" || seen[s] {
				continue
			}
			seen[s] = true
			out.Authors = append(out.Authors, s)
		}
	}
	return out
}
