package text

import (
	"errors"
	"testing"
)

// TestResolveUserOrgID_MatchingMembership: a user with a user_org row in
// the item's owning org gets that row's ID back. This is the happy path
// the stamper hits on every accepted update.
func TestResolveUserOrgID_MatchingMembership(t *testing.T) {
	app := setupAuthTestApp(t)
	f := seedAuthorshipFixture(t, app, "alice@example.com", "org-acme", "doc.docx")

	uoID, err := resolveUserOrgID(app, f.userID, f.itemID)
	if err != nil {
		t.Fatalf("resolveUserOrgID: %v", err)
	}
	if uoID == "" {
		t.Fatalf("expected non-empty userOrgID")
	}
	if uoID != f.userOrgID {
		t.Errorf("userOrgID: got %q, want %q", uoID, f.userOrgID)
	}
}

// TestResolveUserOrgID_NoMembership: a user with no user_org row in the
// item's owning org gets errNoUserOrg. Phase 3a stamping must refuse to
// stamp on behalf of an unrelated user.
func TestResolveUserOrgID_NoMembership(t *testing.T) {
	app := setupAuthTestApp(t)
	f := seedAuthorshipFixture(t, app, "alice@example.com", "org-acme", "doc.docx")
	outsider := mustCreateUser(t, app, "outsider@example.com")

	_, err := resolveUserOrgID(app, outsider.Id, f.itemID)
	if err == nil {
		t.Errorf("expected error for non-member; got nil")
	}
	if !errors.Is(err, errNoUserOrg) {
		t.Errorf("expected errNoUserOrg, got %v", err)
	}
}

// TestResolveUserOrgID_StaleSharePointingAtDifferentOrg: when a user has
// multiple user_org rows across orgs (e.g. they used to be in org-bravo,
// got moved to org-acme, and the item belongs to org-acme), the resolver
// must pick the one matching the item's owning org — not a stale one.
// Same regression the authorize.go cross-org test guards against.
func TestResolveUserOrgID_StaleSharePointingAtDifferentOrg(t *testing.T) {
	app := setupAuthTestApp(t)
	user := mustCreateUser(t, app, "alice@example.com")
	item := seedDriveItemInOrg(t, app, "org-acme", "doc.docx")
	// Membership in the item's org — should be picked.
	wantUserOrgID := seedUserOrg(t, app, user.Id, "org-acme")
	// Stale membership in a different org — must NOT be picked.
	_ = seedUserOrg(t, app, user.Id, "org-bravo")

	uoID, err := resolveUserOrgID(app, user.Id, item.Id)
	if err != nil {
		t.Fatalf("resolveUserOrgID: %v", err)
	}
	if uoID != wantUserOrgID {
		t.Errorf("userOrgID: got %q (org-bravo stale), want %q (org-acme)", uoID, wantUserOrgID)
	}
	// Verify org-of-record is org-acme.
	uo, err := app.FindRecordById("user_org", uoID)
	if err != nil {
		t.Fatalf("find user_org %q: %v", uoID, err)
	}
	if got := uo.GetString("org"); got != "org-acme" {
		t.Errorf("picked user_org with org = %q, want org-acme", got)
	}
}

// TestResolveUserOrgID_NonExistentItem: a request for a drive_item that
// doesn't exist surfaces an error (the resolver wraps the PB error).
func TestResolveUserOrgID_NonExistentItem(t *testing.T) {
	app := setupAuthTestApp(t)
	user := mustCreateUser(t, app, "alice@example.com")

	_, err := resolveUserOrgID(app, user.Id, "nonexistent-item-id")
	if err == nil {
		t.Errorf("expected error for missing item; got nil")
	}
}

// TestResolveUserOrgID_EmptyInputs: empty userID or driveItemID return
// errNoUserOrg without touching the DB — a fail-closed guard against
// blank values from upstream (e.g. a connection with no auth).
func TestResolveUserOrgID_EmptyInputs(t *testing.T) {
	app := setupAuthTestApp(t)

	if _, err := resolveUserOrgID(app, "", "any-item"); !errors.Is(err, errNoUserOrg) {
		t.Errorf("empty userID: want errNoUserOrg, got %v", err)
	}
	if _, err := resolveUserOrgID(app, "any-user", ""); !errors.Is(err, errNoUserOrg) {
		t.Errorf("empty driveItemID: want errNoUserOrg, got %v", err)
	}
}
