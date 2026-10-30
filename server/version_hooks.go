package text

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"
	ycrdt "github.com/skyterra/y-crdt"

	"tinycld.org/core/htmldiff"
	"tinycld.org/core/versionhooks"
	"tinycld.org/packages/text/translate"
)

// versionStateFilename is the on-disk filename used when storing the
// snapshot's Yjs state as a drive_item_versions.yjs_state file. The file
// is opaque binary (yjs update v1 encoding); the .bin suffix exists
// purely so a curious operator inspecting the storage bucket recognizes
// it as non-text. PocketBase prepends its own random prefix so two
// versions never collide on the same key.
const versionStateFilename = "yjs_state.bin"

// registerVersionHooks registers the hook under every MIME type Text edits:
// drive dispatches version hooks by drive_items.mime_type.
func registerVersionHooks(runtime *Runtime) {
	hook := makeSnapshotVersionHook(runtime)
	for _, mime := range []string{docxMimeType, rtfMimeType, rtfMimeTypeAlt} {
		versionhooks.Register(mime, hook)
	}
}

// makeSnapshotVersionHook returns the drive VersionHook: on snapshot it
// captures the live server doc's Yjs state + metadata onto the version row;
// on restore it brings an open document to the restored content.
//
// Both OnSnapshot and OnRestore gracefully no-op when the room isn't
// live — a text doc whose collaboration session has been evicted from
// memory (or never opened) has no in-memory Y.Doc to capture from /
// apply to. The docx round-trip (which drive owns) still works for the
// content; only the protected roots (clientAuthors / clientFirstSeen /
// editEvents) are lost in that case.
func makeSnapshotVersionHook(runtime *Runtime) versionhooks.Hook {
	return versionhooks.Hook{
		OnSnapshot: makeSnapshotVersionHookFn(runtime),
		OnRestore:  makeRestoreVersionHookFn(runtime),
		Render:     renderVersion,
		Diff:       diffVersions,
	}
}

// diffVersions renders both versions and marks what changed from `from` to
// `to`. Both renders are already sanitized; htmldiff adds only its marks
// and escaped text.
func diffVersions(ctx context.Context, app core.App, item, from, to *core.Record, authUserID string) (string, error) {
	toHTML, err := renderVersion(ctx, app, item, to, authUserID)
	if err != nil {
		return "", err
	}
	fromHTML := ""
	if from != nil {
		if fromHTML, err = renderVersion(ctx, app, item, from, authUserID); err != nil {
			return "", err
		}
	}
	return htmldiff.Diff(fromHTML, toHTML)
}

// renderVersion renders a version's own docx for the history preview.
// RenderItemHTML reads the record's `file` and `mime_type`, which a version
// row carries too.
func renderVersion(ctx context.Context, app core.App, _ *core.Record, version *core.Record, authUserID string) (string, error) {
	return RenderItemHTML(ctx, app, version, translate.ImageModeURL, authUserID)
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

// makeRestoreVersionHookFn returns the OnRestore implementation. Drive has
// already put the version's file back on the item. A closed document reads
// that file when it next opens. An open one does not: its room keeps its
// own document and would save it over the restored file. So for a live
// room the hook replaces the document content with the version's, as new
// edits, and broadcasts them so every open editor shows the restored text.
func makeRestoreVersionHookFn(runtime *Runtime) func(core.App, *core.Record, *core.Record) error {
	return func(app core.App, item *core.Record, version *core.Record) error {
		handle := runtime.handleFor(item.Id)
		if handle == nil {
			return nil
		}
		room := runtime.RoomFor(item.Id)
		if room == nil {
			return fmt.Errorf("text: restore room missing for live handle %s", item.Id)
		}
		ctx := context.Background()
		raw, err := readDriveItemBytes(app, version)
		if err != nil {
			return fmt.Errorf("text: read restored version: %w", err)
		}
		docxBytes, err := sourceBytesToDocx(ctx, version.GetString("mime_type"), raw)
		if err != nil {
			return fmt.Errorf("text: normalize restored version: %w", err)
		}
		delta, err := handle.replaceContentFromDocx(ctx, docxBytes)
		if err != nil {
			return fmt.Errorf("text: restore live content: %w", err)
		}
		if len(delta) == 0 {
			return nil
		}
		if err := room.PublishDocUpdate(delta); err != nil {
			return fmt.Errorf("text: restore broadcast: %w", err)
		}
		return nil
	}
}

// captureYjsStateAndMetadata reads the live doc under h.mu and returns
// the encoded full state + computed metadata JSON. The mutex covers both
// the state encode AND the metadata walk so a concurrent ApplyUpdate /
// stampAuthorship can't slip an edit between them. The JSON marshal is
// pure (operates on the already-captured metadata struct, no doc access),
// so we drop the lock before marshaling — keeps concurrent peer edits
// from blocking on the encode.
func captureYjsStateAndMetadata(h *textDocHandle) ([]byte, []byte, error) {
	h.mu.Lock()
	if h.closed || h.doc == nil {
		h.mu.Unlock()
		return nil, nil, fmt.Errorf("text: handle closed during snapshot")
	}
	state := ycrdt.EncodeStateAsUpdate(h.doc, nil)
	metadata := computeMetadata(h.doc)
	h.mu.Unlock()

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
