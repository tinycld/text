package text

import (
	"os"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"github.com/pocketbase/pocketbase/tools/filesystem"
)

// fixtureDocxPath points at the user-curated docx fixture under
// text/tests/assets. Read with os.ReadFile because go:embed paths
// cannot escape the containing package.
const fixtureDocxPath = "../tests/assets/feature-test.docx"

// loadFixtureDocx reads a fixture file from text/tests/assets/. Used
// by bootstrap_test.go and flush_test.go to feed real .docx bytes into
// the runtime + bootstrap chain.
func loadFixtureDocx(t *testing.T, name string) []byte {
	t.Helper()
	path := "../tests/assets/" + name
	bytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("loadFixtureDocx %s: %v", path, err)
	}
	if len(bytes) == 0 {
		t.Fatalf("loadFixtureDocx %s: empty file", path)
	}
	return bytes
}

// setupTestApp creates a tests.TestApp with a minimal drive_items
// collection (just enough to seed a docx blob, re-read it after flush,
// and exercise the bootstrap path). Real production schemas have many
// more fields; we synthesize the bits the bootstrap + flush touch.
//
// Mirrors calc/server/persist_test.go::setupPersistTestApp — both
// packages need the same minimal drive_items shape because both
// bootstrap from and flush back to the same drive collection.
func setupTestApp(t *testing.T) *tests.TestApp {
	t.Helper()
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("tests.NewTestApp: %v", err)
	}
	t.Cleanup(func() { app.Cleanup() })

	items := core.NewBaseCollection(driveItemsCollection)
	items.Fields.Add(&core.TextField{Name: "name"})
	items.Fields.Add(&core.FileField{
		Name:    "file",
		MaxSize: 50 << 20, // 50 MiB — a real document may be large
	})
	items.Fields.Add(&core.NumberField{Name: "size"})
	if err := app.Save(items); err != nil {
		t.Fatalf("save drive_items collection: %v", err)
	}
	return app
}

// seedDriveItem creates a drive_items record with the given file bytes
// attached and returns the saved record. The record's Id is what the
// broker would hand to NewDoc as roomID in production.
func seedDriveItem(t *testing.T, app *tests.TestApp, name string, content []byte) *core.Record {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId(driveItemsCollection)
	if err != nil {
		t.Fatalf("find drive_items collection: %v", err)
	}
	rec := core.NewRecord(collection)
	rec.Set("name", name)
	rec.Set("size", len(content))
	if len(content) > 0 {
		f, err := filesystem.NewFileFromBytes(content, name)
		if err != nil {
			t.Fatalf("NewFileFromBytes: %v", err)
		}
		rec.Set("file", f)
	}
	if err := app.Save(rec); err != nil {
		t.Fatalf("save drive_item record: %v", err)
	}
	return rec
}

// mustCreateUser creates a minimal _superusers record (the built-in
// auth collection in PB's test harness) and returns it as a *core.Record
// suitable for passing to makeAuthorize. Used by authorize_test.go's
// integration tests; the share-grant path is not exercised here (it
// would require populating user_org + drive_shares too).
func mustCreateUser(t *testing.T, app *tests.TestApp, email string) *core.Record {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId("_superusers")
	if err != nil {
		t.Fatalf("find _superusers collection: %v", err)
	}
	rec := core.NewRecord(collection)
	rec.Set("email", email)
	rec.Set("password", "test-password-1234")
	if err := app.Save(rec); err != nil {
		t.Fatalf("save user %s: %v", email, err)
	}
	return rec
}
