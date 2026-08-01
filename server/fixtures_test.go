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
	// mime_type is read by render_endpoint.go's mime-validation gate.
	// Real drive_items records carry this field (defined in the drive
	// sibling's migration); tests need it present so the render
	// handler's docx-only check has something to compare against.
	items.Fields.Add(&core.TextField{Name: "mime_type"})
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatalf("find users collection: %v", err)
	}
	items.Fields.Add(&core.RelationField{
		Name:         "created_by",
		CollectionId: users.Id,
		MaxSelect:    1,
	})
	if err := app.Save(items); err != nil {
		t.Fatalf("save drive_items collection: %v", err)
	}
	return app
}

// setupAuthTestApp builds on setupTestApp by also creating the
// drive_shares collection needed to exercise the authorize path.
// Single-org: drive_shares.user points straight at the users auth
// collection, so there is no junction to synthesize.
func setupAuthTestApp(t *testing.T) *tests.TestApp {
	t.Helper()
	app := setupTestApp(t)

	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatalf("find users collection: %v", err)
	}

	shares := core.NewBaseCollection("drive_shares")
	shares.Fields.Add(&core.TextField{Name: "item", Required: true})
	shares.Fields.Add(&core.RelationField{
		Name:          "user",
		Required:      true,
		CollectionId:  users.Id,
		MaxSelect:     1,
		CascadeDelete: true,
	})
	shares.Fields.Add(&core.SelectField{
		Name:      "role",
		Required:  true,
		Values:    []string{"owner", "editor", "viewer"},
		MaxSelect: 1,
	})
	if err := app.Save(shares); err != nil {
		t.Fatalf("save drive_shares collection: %v", err)
	}
	return app
}

// seedSharedItem creates a drive_items record for the authorization
// tests and returns its saved record. Pass a nil creator to isolate the
// share-row path from the created_by branch driveshare also honors.
// (seedDriveItem below is a different helper — it attaches file bytes.)
func seedSharedItem(t *testing.T, app *tests.TestApp, creator *core.Record, name string) *core.Record {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId(driveItemsCollection)
	if err != nil {
		t.Fatalf("find drive_items collection: %v", err)
	}
	rec := core.NewRecord(collection)
	rec.Set("name", name)
	rec.Set("size", 0)
	if creator != nil {
		rec.Set("created_by", creator.Id)
	}
	if err := app.Save(rec); err != nil {
		t.Fatalf("save drive_item record: %v", err)
	}
	return rec
}

// seedShare creates a drive_shares row binding the user to the
// drive_item with the given role.
func seedShare(t *testing.T, app *tests.TestApp, itemID, userID, role string) {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId("drive_shares")
	if err != nil {
		t.Fatalf("find drive_shares collection: %v", err)
	}
	rec := core.NewRecord(collection)
	rec.Set("item", itemID)
	rec.Set("user", userID)
	rec.Set("role", role)
	if err := app.Save(rec); err != nil {
		t.Fatalf("save drive_shares record: %v", err)
	}
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

// authorshipFixture bundles the records seeded by seedAuthorshipFixture
// so tests can reference them by name (instead of re-deriving IDs from
// raw collection queries). Mirrors how the broker's stamping path sees
// the world: one user, one drive_item.
type authorshipFixture struct {
	userID string
	itemID string
}

// seedAuthorshipFixture creates the minimum record set the stamper
// expects: one user (auth record) and one drive_item they created.
// Returned IDs are the real PB record IDs so callers can assert against
// them.
//
// Single-org: the stamped author id IS the user id, so there is no
// membership row to seed — the stamper reads conn.AuthID() directly.
func seedAuthorshipFixture(t *testing.T, app *tests.TestApp, email, itemName string) authorshipFixture {
	t.Helper()
	user := mustCreateUser(t, app, email)
	item := seedSharedItem(t, app, user, itemName)
	return authorshipFixture{
		userID: user.Id,
		itemID: item.Id,
	}
}

// mustCreateUser creates a minimal users record and returns it as a
// *core.Record suitable for passing to makeAuthorize. Must be the real
// users collection, not _superusers: drive_shares.user and
// drive_items.created_by are relations that validate their target.
func mustCreateUser(t *testing.T, app *tests.TestApp, email string) *core.Record {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatalf("find users collection: %v", err)
	}
	rec := core.NewRecord(collection)
	rec.Set("email", email)
	rec.Set("password", "test-password-1234")
	if err := app.Save(rec); err != nil {
		t.Fatalf("save user %s: %v", email, err)
	}
	return rec
}
