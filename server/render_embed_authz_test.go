package text

import (
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"github.com/pocketbase/pocketbase/tools/filesystem"
)

// These tests cover the AUTHORIZATION gate inside makeEmbedFetcher —
// the IDOR fix in render_endpoint.go. The embed fetcher resolves an
// image src straight out of user-authored document content and reads
// the referenced file's bytes off disk. app.FindRecordById bypasses
// PocketBase collection rules, so the fetcher must re-impose the read
// authorization PB would normally enforce: only drive_items records,
// and only when the CALLER holds a live share on that exact record
// (resolveShareRole, the same org-constrained predicate that gates the
// render target and realtime room admission).
//
// The regression these guard against: any editor could embed another
// org's file URL (e.g. .../api/files/drive_items/<victimRec>/<file>)
// and exfiltrate its bytes through the rendered output.
//
// We test at the level the fix lives — the makeEmbedFetcher closure
// directly — because that's the single seam every render path (the
// authenticated endpoint and the share-link render) funnels through.

// seedDriveItemWithFileInOrg creates a drive_items record tagged to org
// with a real file attachment, and returns the record plus the src URL
// a document would carry to embed that file. PocketBase normalizes the
// stored filename (adds a hash suffix), so the src must be built from
// the persisted `file` value — not the name we passed in — for the
// fetcher's storage-key lookup to resolve.
func seedDriveItemWithFileInOrg(t *testing.T, app *tests.TestApp, orgID, name string, content []byte) (*core.Record, string) {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId(driveItemsCollection)
	if err != nil {
		t.Fatalf("find drive_items collection: %v", err)
	}
	rec := core.NewRecord(collection)
	rec.Set("name", name)
	rec.Set("size", len(content))
	rec.Set("org", orgID)
	f, err := filesystem.NewFileFromBytes(content, name)
	if err != nil {
		t.Fatalf("NewFileFromBytes: %v", err)
	}
	rec.Set("file", f)
	if err := app.Save(rec); err != nil {
		t.Fatalf("save drive_item record: %v", err)
	}
	storedName := rec.GetString("file")
	if storedName == "" {
		t.Fatalf("drive_item has no stored file after save")
	}
	src := "https://app.example.com/api/files/" + driveItemsCollection + "/" + rec.Id + "/" + storedName
	return rec, src
}

// pngBytes is a minimal but valid-enough payload standing in for the
// secret image bytes an embedded file would hold. The fetcher never
// decodes it; we only care whether the closure hands the bytes back.
var pngBytes = []byte("\x89PNG\r\n\x1a\nSECRET-IMAGE-BYTES")

// TestEmbedFetcher_DeniesCrossOrgNoShare is the KEY IDOR regression.
// A user in org A asks (via document content they authored) to embed a
// drive_items file owned by org B, with no share granting them access.
// The fetcher must deny — returning an error and NO bytes — rather than
// reading org B's file off disk and inlining it into org A's render.
func TestEmbedFetcher_DeniesCrossOrgNoShare(t *testing.T) {
	app := setupAuthTestApp(t)

	attacker := mustCreateUser(t, app, "attacker@org-a.example.com")
	// Attacker is a legitimate member of org A...
	seedUserOrg(t, app, attacker.Id, "org-a")

	// ...but the target file lives in org B, and the attacker holds no
	// share on it.
	_, src := seedDriveItemWithFileInOrg(t, app, "org-b", "victim-secret.png", pngBytes)

	fetch := makeEmbedFetcher(app, attacker.Id)
	mime, data, err := fetch(src)
	if err == nil {
		t.Fatalf("cross-org embed must be denied, got mime=%q %d bytes", mime, len(data))
	}
	if len(data) != 0 {
		t.Fatalf("denied embed must disclose NO bytes, got %d", len(data))
	}
}

// TestEmbedFetcher_DeniesCrossOrgStaleShare hardens the previous case:
// the attacker DOES have a drive_shares row for the target item, but it
// is keyed to a user_org in the wrong org (org A) while the item lives
// in org B — a stale share from a prior membership. resolveShareRole
// constrains user_org.org to the item's org, so this must still deny.
func TestEmbedFetcher_DeniesCrossOrgStaleShare(t *testing.T) {
	app := setupAuthTestApp(t)

	attacker := mustCreateUser(t, app, "stale@org-a.example.com")
	item, src := seedDriveItemWithFileInOrg(t, app, "org-b", "victim-secret.png", pngBytes)

	// Stale share: user_org is in org A, item is in org B.
	staleUserOrgID := seedUserOrg(t, app, attacker.Id, "org-a")
	seedShare(t, app, item.Id, staleUserOrgID, "editor")

	fetch := makeEmbedFetcher(app, attacker.Id)
	mime, data, err := fetch(src)
	if err == nil {
		t.Fatalf("stale cross-org share must be denied, got mime=%q %d bytes", mime, len(data))
	}
	if len(data) != 0 {
		t.Fatalf("denied embed must disclose NO bytes, got %d", len(data))
	}
}

// TestEmbedFetcher_AllowsShared is the positive control: a user with a
// valid share (same org as the item) on the referenced drive_items
// record gets the bytes back. Without this we couldn't tell a working
// fetcher from one that denies everything.
func TestEmbedFetcher_AllowsShared(t *testing.T) {
	app := setupAuthTestApp(t)

	user := mustCreateUser(t, app, "member@org-a.example.com")
	item, src := seedDriveItemWithFileInOrg(t, app, "org-a", "shared.png", pngBytes)
	userOrgID := seedUserOrg(t, app, user.Id, "org-a")
	seedShare(t, app, item.Id, userOrgID, "viewer")

	fetch := makeEmbedFetcher(app, user.Id)
	mime, data, err := fetch(src)
	if err != nil {
		t.Fatalf("authorized embed must succeed, got error: %v", err)
	}
	if len(data) == 0 {
		t.Fatalf("authorized embed returned no bytes")
	}
	if string(data) != string(pngBytes) {
		t.Fatalf("authorized embed returned wrong bytes: got %q want %q", data, pngBytes)
	}
	if mime != "image/png" {
		t.Fatalf("mime: got %q want image/png", mime)
	}
}

// seedOtherCollectionRecordWithFile creates a record with a real file
// attachment in a NON-drive_items collection, returning the src URL that
// would embed it. This exists so the wrong-collection test references a
// record that genuinely holds readable bytes: dropping the allowlist
// then discloses those bytes, which is exactly the leak the allowlist
// prevents. (Pointing at a fileless collection would "pass" the test
// for the wrong reason — a missing file, not the allowlist.)
func seedOtherCollectionRecordWithFile(t *testing.T, app *tests.TestApp, collName string, content []byte) string {
	t.Helper()
	coll := core.NewBaseCollection(collName)
	coll.Fields.Add(&core.FileField{Name: "file", MaxSize: 1 << 20})
	if err := app.Save(coll); err != nil {
		t.Fatalf("save %s collection: %v", collName, err)
	}
	rec := core.NewRecord(coll)
	f, err := filesystem.NewFileFromBytes(content, "secret.png")
	if err != nil {
		t.Fatalf("NewFileFromBytes: %v", err)
	}
	rec.Set("file", f)
	if err := app.Save(rec); err != nil {
		t.Fatalf("save %s record: %v", collName, err)
	}
	storedName := rec.GetString("file")
	return "https://app.example.com/api/files/" + collName + "/" + rec.Id + "/" + storedName
}

// TestEmbedFetcher_DeniesWrongCollection covers the collection
// allowlist. The fetcher only knows how to authorize drive_items, so a
// src naming any other collection must be a hard deny — even when the
// record exists and holds a readable file. The referenced record here
// is a real row with attached bytes in a non-drive_items collection, so
// removing the allowlist would disclose those bytes; the fix must keep
// them sealed.
func TestEmbedFetcher_DeniesWrongCollection(t *testing.T) {
	app := setupAuthTestApp(t)

	user := mustCreateUser(t, app, "user@org-a.example.com")
	src := seedOtherCollectionRecordWithFile(t, app, "mail_messages", pngBytes)

	fetch := makeEmbedFetcher(app, user.Id)
	mime, data, err := fetch(src)
	if err == nil {
		t.Fatalf("non-drive_items collection must be denied, got mime=%q %d bytes", mime, len(data))
	}
	if len(data) != 0 {
		t.Fatalf("denied embed must disclose NO bytes, got %d", len(data))
	}
}

// TestEmbedFetcher_DeniesEmptyAuthUser fails closed when there is no
// authenticated subject (e.g. a share-link render reaching the shared
// writer). Serving bytes with no subject to authorize is unsafe even
// though the record and file exist and are otherwise readable.
func TestEmbedFetcher_DeniesEmptyAuthUser(t *testing.T) {
	app := setupAuthTestApp(t)

	item, src := seedDriveItemWithFileInOrg(t, app, "org-a", "shared.png", pngBytes)
	// A share exists for SOME user_org, but the fetcher is built with an
	// empty authUserID, so there is no subject to match against.
	userOrgID := seedUserOrg(t, app, "some-user-id", "org-a")
	seedShare(t, app, item.Id, userOrgID, "owner")

	fetch := makeEmbedFetcher(app, "")
	mime, data, err := fetch(src)
	if err == nil {
		t.Fatalf("empty auth user must be denied, got mime=%q %d bytes", mime, len(data))
	}
	if len(data) != 0 {
		t.Fatalf("denied embed must disclose NO bytes, got %d", len(data))
	}
}

// TestEmbedFetcher_DeniesTraversalFilename confirms the closure inherits
// parseDriveFileURL's path-segment rejection: a filename carrying a
// ".." escapes the record's file directory and must be dropped before
// any authorization or read is attempted. (parseDriveFileURL is unit
// tested directly in render_endpoint_test.go; this asserts the fetcher
// wires that rejection through as a drop, not a partial read.)
func TestEmbedFetcher_DeniesTraversalFilename(t *testing.T) {
	app := setupAuthTestApp(t)

	user := mustCreateUser(t, app, "trav@org-a.example.com")
	item, _ := seedDriveItemWithFileInOrg(t, app, "org-a", "shared.png", pngBytes)
	userOrgID := seedUserOrg(t, app, user.Id, "org-a")
	seedShare(t, app, item.Id, userOrgID, "owner")

	// Even fully authorized on the record, a traversal filename is a
	// hard drop.
	src := "https://app.example.com/api/files/" + driveItemsCollection + "/" + item.Id + "/../secret.png"

	fetch := makeEmbedFetcher(app, user.Id)
	mime, data, err := fetch(src)
	if err == nil {
		t.Fatalf("traversal filename must be denied, got mime=%q %d bytes", mime, len(data))
	}
	if len(data) != 0 {
		t.Fatalf("denied embed must disclose NO bytes, got %d", len(data))
	}
}
