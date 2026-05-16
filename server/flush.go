package text

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"

	"tinycld.org/core/realtime"
	"tinycld.org/packages/text/translate"
)

// makeProductionFlush returns a FlushFn that the SaveCoordinator
// invokes for each text room. The flow is:
//
//  1. Snapshot the Y.Doc as ProseMirror JSON via translate.PMJSONFromYDoc.
//  2. Convert to .docx bytes via translate.PMJSONToDocx.
//  3. Reload the drive_items record and overwrite its `file` field.
//
// The returned closure is safe to call concurrently for different
// rooms; the SaveCoordinator never re-enters the same room concurrently.
//
// PMJSONToDocx wraps WordZero, which has historically panicked on
// malformed inputs. Concurrent calls from different rooms are
// serialized inside the translate package via numberingMu — WordZero's
// NumberingManager is a process-global singleton. The named-return +
// deferred recover here converts any remaining panic into an error so
// the SaveCoordinator's retry/backoff path can handle it instead of
// the broker goroutine going down.
func makeProductionFlush(app core.App, _ *Runtime) realtime.FlushFn {
	return func(driveItemID string, handle realtime.DocHandle) (returnedErr error) {
		defer func() {
			if r := recover(); r != nil {
				app.Logger().Error("text: flush panicked",
					"driveItemID", driveItemID, "panic", r)
				returnedErr = fmt.Errorf("text: flush panicked for %s: %v", driveItemID, r)
			}
		}()

		if handle == nil {
			return fmt.Errorf("text: flush called with nil handle for %s", driveItemID)
		}
		th, ok := handle.(*textDocHandle)
		if !ok {
			return fmt.Errorf("text: flush expected *textDocHandle, got %T", handle)
		}

		th.mu.Lock()
		closed := th.closed
		doc := th.doc
		th.mu.Unlock()
		if closed || doc == nil {
			return fmt.Errorf("text: flush on closed room %s", driveItemID)
		}

		pmJSON, err := translate.PMJSONFromYDoc(doc)
		if err != nil {
			return fmt.Errorf("text: serialize Y.Doc for %s: %w", driveItemID, err)
		}

		docxBytes, err := translate.PMJSONToDocx(pmJSON)
		if err != nil {
			return fmt.Errorf("text: PMJSONToDocx for %s: %w", driveItemID, err)
		}
		if len(docxBytes) == 0 {
			return fmt.Errorf("text: PMJSONToDocx produced empty bytes for %s", driveItemID)
		}

		item, err := app.FindRecordById(driveItemsCollection, driveItemID)
		if err != nil {
			return fmt.Errorf("text: load drive_items %s: %w", driveItemID, err)
		}

		// Reuse the original filename so URLs / mime detection stay
		// consistent. PocketBase will rename the on-disk blob to a
		// fresh hash on save, so the prior blob isn't overwritten in
		// place.
		filename := item.GetString("file")
		if filename == "" {
			filename = "untitled.docx"
		}
		fileRef, err := filesystem.NewFileFromBytes(docxBytes, filename)
		if err != nil {
			return fmt.Errorf("text: build filesystem.File for %s: %w", driveItemID, err)
		}
		item.Set("file", fileRef)
		item.Set("size", len(docxBytes))

		if err := app.Save(item); err != nil {
			return fmt.Errorf("text: save drive_items %s: %w", driveItemID, err)
		}
		return nil
	}
}
