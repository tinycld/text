package text

import (
	"errors"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"
	"tinycld.org/packages/text/translate"
)

// TestFlush_PersistsToDrive runs a full save cycle: bootstrap a doc
// from the fixture, run the production flush, fetch the drive_item
// back, and verify the file blob and size were updated.
func TestFlush_PersistsToDrive(t *testing.T) {
	app := setupTestApp(t)
	fixture := loadFixtureDocx(t, "feature-test.docx")
	item := seedDriveItem(t, app, "feature-test.docx", fixture)

	runtime := NewRuntime()
	runtime.SetBootstrap(makeDocxBootstrap(app, runtime))
	handle, err := runtime.NewDoc(item.Id)
	if err != nil {
		t.Fatalf("NewDoc: %v", err)
	}
	defer func() { _ = handle.Close() }()

	flush := makeProductionFlush(app, runtime)
	if err := flush(t.Context(), item.Id, handle); err != nil {
		t.Fatalf("flush: %v", err)
	}

	updated, err := app.FindRecordById(driveItemsCollection, item.Id)
	if err != nil {
		t.Fatalf("re-fetch: %v", err)
	}
	if updated.GetString("file") == "" {
		t.Error("drive_item file is empty after flush")
	}
	if updated.GetInt("size") <= 0 {
		t.Errorf("drive_item size is non-positive (%d) after flush", updated.GetInt("size"))
	}

	// Read the file bytes back to confirm flush wrote a real docx.
	bytesAfter, err := readDriveItemBytes(app, updated)
	if err != nil {
		t.Fatalf("readDriveItemBytes after flush: %v", err)
	}
	if len(bytesAfter) == 0 {
		t.Fatal("file bytes empty after flush")
	}
	// docx files are ZIP containers; the ZIP signature is "PK\x03\x04".
	if len(bytesAfter) < 4 || string(bytesAfter[:2]) != "PK" {
		t.Errorf("flushed bytes don't look like a docx (zip header missing): first bytes %v", bytesAfter[:min(4, len(bytesAfter))])
	}
}

// TestFlush_NilHandleReturnsErr is the misuse-guard test mirroring
// calc's TestSaveRoomNilHandleReturnsError. A nil handle should error
// rather than panic.
func TestFlush_NilHandleReturnsErr(t *testing.T) {
	app := setupTestApp(t)
	runtime := NewRuntime()
	flush := makeProductionFlush(app, runtime)
	if err := flush(t.Context(), "any-id", nil); err == nil {
		t.Fatal("expected nil-handle to error")
	}
}

// TestFlush_ClosedHandleReturnsErr confirms a flush against a closed
// handle surfaces an error rather than crashing the SaveCoordinator.
func TestFlush_ClosedHandleReturnsErr(t *testing.T) {
	app := setupTestApp(t)
	item := seedDriveItem(t, app, "x.docx", []byte{})

	runtime := NewRuntime()
	handle, err := runtime.NewDoc(item.Id)
	if err != nil {
		t.Fatalf("NewDoc: %v", err)
	}
	if err := handle.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	flush := makeProductionFlush(app, runtime)
	if err := flush(t.Context(), item.Id, handle); err == nil {
		t.Fatal("expected closed-handle to error")
	}
}

// TestFlush_MissingDriveItemReturnsErr: passing a roomID that no
// drive_items row matches must surface the FindRecordById failure
// (rather than silently no-op).
func TestFlush_MissingDriveItemReturnsErr(t *testing.T) {
	app := setupTestApp(t)
	fixture := loadFixtureDocx(t, "feature-test.docx")
	item := seedDriveItem(t, app, "feature-test.docx", fixture)

	runtime := NewRuntime()
	runtime.SetBootstrap(makeDocxBootstrap(app, runtime))
	handle, err := runtime.NewDoc(item.Id)
	if err != nil {
		t.Fatalf("NewDoc: %v", err)
	}
	defer func() { _ = handle.Close() }()

	flush := makeProductionFlush(app, runtime)
	if err := flush(t.Context(), "nonexistent-id", handle); err == nil {
		t.Fatal("expected missing-drive-item to error")
	}
}

// TestSaveCoordinator_DebounceCadence is intentionally skipped:
// SaveCoordinator's interval fields (debounceEvery, ceilingEvery,
// teardownTimeout) are unexported, so a test in this package can't
// shrink them without time.Sleep'ing through the production defaults
// (3s + 15s) — too flaky and too slow to be useful as a regression
// guard. Cadence behavior is owned by core's save_coordinator_test.go,
// which is in the same package and can mutate the fields directly.
//
// A v2 ergonomics improvement would be to add a small public
// Configure / WithIntervals constructor to SaveCoordinator and let
// downstream packages drive cadence tests directly. Track separately.
func TestSaveCoordinator_DebounceCadence(t *testing.T) {
	t.Skip("SaveCoordinator interval fields are unexported; cadence is exercised in core's save_coordinator_test.go")
}

// TestDriveImageResolver_ReadsStorageOncePerBlob: the resolver serves a
// second request for the same image from the room's cache, and a record
// that names a different blob (the image was re-uploaded) is a miss, so a
// save never embeds stale bytes.
func TestDriveImageResolver_ReadsStorageOncePerBlob(t *testing.T) {
	app := setupTestApp(t)
	img := seedDriveItem(t, app, "photo.png", []byte("png-bytes-v1"))
	img.Set("mime_type", "image/png")
	if err := app.Save(img); err != nil {
		t.Fatal(err)
	}

	var cache imageCache
	resolve := makeDriveImageResolver(app, &cache, nil)

	first, err := resolve(img.Id, "ignored")
	if err != nil {
		t.Fatalf("first resolve: %v", err)
	}
	if string(first) != "png-bytes-v1" {
		t.Fatalf("first resolve = %q", first)
	}
	if _, ok := cache.get(img.Id + "/" + img.GetString("file")); !ok {
		t.Fatal("the resolved bytes were not cached under the stored blob name")
	}

	// Replace the stored blob behind the resolver's back: PocketBase stores
	// it under a new name, so the cache must miss and re-read.
	replaced, err := filesystem.NewFileFromBytes([]byte("png-bytes-v2"), "photo.png")
	if err != nil {
		t.Fatalf("NewFileFromBytes: %v", err)
	}
	img.Set("file", replaced)
	if err := app.Save(img); err != nil {
		t.Fatalf("save replaced image: %v", err)
	}
	second, err := resolve(img.Id, "ignored")
	if err != nil {
		t.Fatalf("second resolve: %v", err)
	}
	if string(second) != "png-bytes-v2" {
		t.Fatalf("second resolve = %q; want the re-uploaded bytes", second)
	}

	cache.clear()
	if _, ok := cache.get(img.Id + "/" + img.GetString("file")); ok {
		t.Fatal("clear left an entry in the cache")
	}
}

// An image inserted before attached_to existed is attached to the document
// on the next save, when the document's owner inserted it, so the
// document's viewers can load it. An image someone else uploaded is left
// alone: a pasted src must not hand a stranger's image to this document.
func TestDriveImageResolver_AttachesTheOwnersLegacyImage(t *testing.T) {
	app := setupTestApp(t)
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}
	newUser := func(email string) *core.Record {
		u := core.NewRecord(users)
		u.SetEmail(email)
		u.SetPassword("Password123!")
		if err := app.Save(u); err != nil {
			t.Fatal(err)
		}
		return u
	}
	owner, other := newUser("owner@test.local"), newUser("other@test.local")
	seed := func(name, mime, parent string, u *core.Record) *core.Record {
		rec := seedDriveItem(t, app, name, []byte(name))
		rec.Set("created_by", u.Id)
		rec.Set("mime_type", mime)
		rec.Set("parent", parent)
		if err := app.Save(rec); err != nil {
			t.Fatal(err)
		}
		return rec
	}
	doc := seed("doc.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "", owner)
	mine := seed("mine.png", "image/png", "", owner)
	theirs := seed("theirs.png", "image/png", "", other)
	filed := seed("filed.png", "image/png", "somefolder", owner)

	resolve := makeDriveImageResolver(app, nil, doc)
	for _, img := range []*core.Record{mine, theirs, filed} {
		if _, err := resolve(img.Id, "ignored"); err != nil {
			t.Fatalf("resolve %s: %v", img.GetString("name"), err)
		}
	}

	if got := reload(t, app, mine).GetString("attached_to"); got != doc.Id {
		t.Fatalf("owner's image attached_to = %q, want the document", got)
	}
	if got := reload(t, app, theirs).GetString("attached_to"); got != "" {
		t.Fatalf("another user's image attached_to = %q, want it left alone", got)
	}
	// Inserted images live in the Drive root; one the owner filed in a
	// folder is a file they manage, not part of this document.
	if got := reload(t, app, filed).GetString("attached_to"); got != "" {
		t.Fatalf("owner's filed image attached_to = %q, want it left alone", got)
	}
}

// Only images embed: an src naming any other drive item (a PDF, a sheet)
// is dropped, never copied into the document's docx.
func TestDriveImageResolver_RefusesANonImageItem(t *testing.T) {
	app := setupTestApp(t)
	pdf := seedDriveItem(t, app, "secret.pdf", []byte("%PDF"))
	pdf.Set("mime_type", "application/pdf")
	if err := app.Save(pdf); err != nil {
		t.Fatal(err)
	}

	_, err := makeDriveImageResolver(app, nil, nil)(pdf.Id, "secret.png")
	if !errors.Is(err, translate.ErrImageUnavailable) {
		t.Fatalf("err = %v, want ErrImageUnavailable", err)
	}
}

func reload(t *testing.T, app core.App, rec *core.Record) *core.Record {
	t.Helper()
	fresh, err := app.FindRecordById(rec.Collection().Id, rec.Id)
	if err != nil {
		t.Fatal(err)
	}
	return fresh
}
