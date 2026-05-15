package text

import (
	"fmt"
	"io"

	"github.com/pocketbase/pocketbase/core"
	ycrdt "github.com/skyterra/y-crdt"

	"tinycld.org/packages/text/translate"
)

// driveItemsCollection is the PocketBase collection where text
// document blobs live. The roomID handed to a text RealtimeRoom IS
// the drive_items.id — text shares drive's collection (text documents
// ARE drive_items with mime=docx).
const driveItemsCollection = "drive_items"

// makeDocxBootstrap returns the runtime bootstrap closure. On first
// open of a text room, it loads the drive_items docx referenced by
// roomID, parses it via translate.DocxToPMJSON, and seeds the result
// into the freshly-minted server-side Y.Doc.
//
// The hook is invoked synchronously inside Runtime.NewDoc, before the
// broker delivers any SyncReply. So peers always see populated state
// regardless of join order.
//
// A drive_item with no attached file (newly-created, mid-upload) reads
// as zero bytes; the closure returns nil and the room continues with
// an empty Y.Doc. Subsequent edits flow normally; the flush will
// write a docx out from scratch on the first save.
//
// Parser warnings (tracked changes stripped, unsupported nodes coerced,
// etc.) are stashed on the runtime keyed by roomID for the OnConnect
// ServerHelloFn to surface to the joining client via MsgServerHello.
func makeDocxBootstrap(app core.App, runtime *Runtime) func(roomID string, doc *ycrdt.Doc) error {
	return func(roomID string, doc *ycrdt.Doc) error {
		item, err := app.FindRecordById(driveItemsCollection, roomID)
		if err != nil {
			return fmt.Errorf("text: load drive_items %s: %w", roomID, err)
		}
		docxBytes, err := readDriveItemBytes(app, item)
		if err != nil {
			return fmt.Errorf("text: read docx for %s: %w", roomID, err)
		}
		if len(docxBytes) == 0 {
			// Empty file; first edit populates the Y.Doc and the
			// flush serializes a fresh docx.
			return nil
		}

		pmJSON, warnings, err := translate.DocxToPMJSON(docxBytes)
		if err != nil {
			return fmt.Errorf("text: parse docx for %s: %w", roomID, err)
		}

		if err := translate.SeedFromPMJSON(doc, pmJSON); err != nil {
			return fmt.Errorf("text: seed Y.Doc for %s: %w", roomID, err)
		}

		runtime.SetImportWarnings(roomID, warnings)
		return nil
	}
}

// readDriveItemBytes loads the file attachment from a drive_items
// record. Mirrors calc/server/persist.go::readDriveItemBytes verbatim —
// both packages read drive_items the same way; the only divergence is
// what's done with the bytes after.
func readDriveItemBytes(app core.App, item *core.Record) ([]byte, error) {
	filename := item.GetString("file")
	if filename == "" {
		return nil, nil
	}

	fsys, err := app.NewFilesystem()
	if err != nil {
		return nil, fmt.Errorf("open filesystem: %w", err)
	}
	defer fsys.Close()

	key := item.BaseFilesPath() + "/" + filename
	rdr, err := fsys.GetReader(key)
	if err != nil {
		return nil, fmt.Errorf("get reader for %s: %w", key, err)
	}
	defer rdr.Close()

	return io.ReadAll(rdr)
}
