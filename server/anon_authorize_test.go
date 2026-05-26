package text

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"tinycld.org/core/realtime"
	"tinycld.org/core/sharelink"
)

// setupShareTestApp extends setupAuthTestApp with the drive_share_links
// collection so that authorizeAnonShare / ResolveLink can run end-to-end.
func setupShareTestApp(t *testing.T) *tests.TestApp {
	t.Helper()
	app := setupAuthTestApp(t)

	items, err := app.FindCollectionByNameOrId(driveItemsCollection)
	if err != nil {
		t.Fatalf("find drive_items collection: %v", err)
	}
	links := core.NewBaseCollection("drive_share_links")
	links.Fields.Add(&core.RelationField{
		Name:          "item",
		Required:      true,
		CollectionId:  items.Id,
		MaxSelect:     1,
		CascadeDelete: true,
	})
	links.Fields.Add(&core.TextField{Name: "token", Required: true})
	links.Fields.Add(&core.SelectField{
		Name:      "role",
		Required:  true,
		MaxSelect: 1,
		Values:    []string{sharelink.RoleViewer, sharelink.RoleCommentor, sharelink.RoleEditor},
	})
	links.Fields.Add(&core.BoolField{Name: "is_active"})
	links.Fields.Add(&core.DateField{Name: "expires_at"})
	if err := app.Save(links); err != nil {
		t.Fatalf("save drive_share_links collection: %v", err)
	}
	return app
}

// seedShareLink inserts a drive_item + drive_share_links row and returns
// the 64-char token and the item id.
func seedShareLink(t *testing.T, app *tests.TestApp, role string, active bool) (token, itemID string) {
	t.Helper()
	item := seedDriveItemInOrg(t, app, "org-acme", "doc.docx")

	tok := strings.Repeat("a", 64-len(item.Id)) + item.Id

	linksCol, err := app.FindCollectionByNameOrId("drive_share_links")
	if err != nil {
		t.Fatalf("find drive_share_links: %v", err)
	}
	link := core.NewRecord(linksCol)
	link.Set("item", item.Id)
	link.Set("token", tok)
	link.Set("role", role)
	link.Set("is_active", active)
	if err := app.Save(link); err != nil {
		t.Fatalf("save share link: %v", err)
	}
	return tok, item.Id
}

// TestAuthorizeAnonShare_AdmitsViewer checks that a viewer-role anon
// share link is now ADMITTED (returns nil) by authorizeAnonShare.
// Previously the function required RoleEditor; after this change any
// valid role is accepted — write enforcement is downstream in the broker.
func TestAuthorizeAnonShare_AdmitsViewer(t *testing.T) {
	app := setupShareTestApp(t)
	tok, itemID := seedShareLink(t, app, sharelink.RoleViewer, true)

	claims := realtime.ShareClaims{ShareToken: tok, ItemID: itemID, Role: sharelink.RoleViewer}
	if err := authorizeAnonShare(app, claims, itemID); err != nil {
		t.Errorf("viewer anon: expected nil (admitted), got %v", err)
	}
}

// TestAuthorizeAnonShare_AdmitsCommentor checks that a commentor-role
// anon share link is ADMITTED.
func TestAuthorizeAnonShare_AdmitsCommentor(t *testing.T) {
	app := setupShareTestApp(t)
	tok, itemID := seedShareLink(t, app, sharelink.RoleCommentor, true)

	claims := realtime.ShareClaims{ShareToken: tok, ItemID: itemID, Role: sharelink.RoleCommentor}
	if err := authorizeAnonShare(app, claims, itemID); err != nil {
		t.Errorf("commentor anon: expected nil (admitted), got %v", err)
	}
}

// TestAuthorizeAnonShare_AdmitsEditor checks that an editor-role anon
// share link is still ADMITTED (regression guard).
func TestAuthorizeAnonShare_AdmitsEditor(t *testing.T) {
	app := setupShareTestApp(t)
	tok, itemID := seedShareLink(t, app, sharelink.RoleEditor, true)

	claims := realtime.ShareClaims{ShareToken: tok, ItemID: itemID, Role: sharelink.RoleEditor}
	if err := authorizeAnonShare(app, claims, itemID); err != nil {
		t.Errorf("editor anon: expected nil (admitted), got %v", err)
	}
}

// TestAuthorizeAnonShare_RejectsItemIDMismatch verifies that a claims.ItemID
// that does not match roomID is rejected immediately (no DB lookup).
func TestAuthorizeAnonShare_RejectsItemIDMismatch(t *testing.T) {
	app := setupShareTestApp(t)
	tok, _ := seedShareLink(t, app, sharelink.RoleViewer, true)

	claims := realtime.ShareClaims{ShareToken: tok, ItemID: "different-room-id", Role: sharelink.RoleViewer}
	err := authorizeAnonShare(app, claims, "different-room-id")
	if !errors.Is(err, errNoShare) {
		t.Errorf("itemID mismatch: expected errNoShare, got %v", err)
	}
}

// TestAuthorizeAnonShare_RejectsRevokedLink verifies that a revoked
// (is_active=false) link is rejected.
func TestAuthorizeAnonShare_RejectsRevokedLink(t *testing.T) {
	app := setupShareTestApp(t)
	tok, itemID := seedShareLink(t, app, sharelink.RoleViewer, false /* revoked */)

	claims := realtime.ShareClaims{ShareToken: tok, ItemID: itemID, Role: sharelink.RoleViewer}
	if err := authorizeAnonShare(app, claims, itemID); err == nil {
		t.Error("revoked link: expected non-nil error, got nil")
	}
}

// TestAuthorizeAnonShare_AnonIsReadOnly exercises isReadOnlyForConn for
// anon connections: viewer and commentor → read-only; editor → writable.
func TestAuthorizeAnonShare_AnonIsReadOnly(t *testing.T) {
	app := setupShareTestApp(t)
	item := seedDriveItemInOrg(t, app, "org-acme", "doc.docx")

	cases := []struct {
		shareRole string
		wantRO    bool
	}{
		{sharelink.RoleViewer, true},
		{sharelink.RoleCommentor, true},
		{sharelink.RoleEditor, false},
	}
	for _, c := range cases {
		t.Run(c.shareRole, func(t *testing.T) {
			conn := realtime.NewAnonClientForTest(c.shareRole, "Anon Tiger")
			got := isReadOnlyForConn(app, item.Id, conn)
			if got != c.wantRO {
				t.Errorf("isReadOnlyForConn(anon %s): got %v, want %v", c.shareRole, got, c.wantRO)
			}
		})
	}
}

// TestAuthorizeAnonShare_Expired verifies that an expired link is rejected.
func TestAuthorizeAnonShare_Expired(t *testing.T) {
	app := setupShareTestApp(t)
	item := seedDriveItemInOrg(t, app, "org-acme", "doc.docx")
	tok := strings.Repeat("b", 64-len(item.Id)) + item.Id

	linksCol, err := app.FindCollectionByNameOrId("drive_share_links")
	if err != nil {
		t.Fatalf("find drive_share_links: %v", err)
	}
	link := core.NewRecord(linksCol)
	link.Set("item", item.Id)
	link.Set("token", tok)
	link.Set("role", sharelink.RoleViewer)
	link.Set("is_active", true)
	link.Set("expires_at", time.Now().Add(-time.Hour).UTC().Format(time.RFC3339))
	if err := app.Save(link); err != nil {
		t.Fatalf("save expired link: %v", err)
	}

	claims := realtime.ShareClaims{ShareToken: tok, ItemID: item.Id, Role: sharelink.RoleViewer}
	if err := authorizeAnonShare(app, claims, item.Id); err == nil {
		t.Error("expired link: expected non-nil error, got nil")
	}
}
