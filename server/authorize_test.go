package text

import (
	"errors"
	"testing"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/driveshare"
	"tinycld.org/core/realtime"
)

// TestRegisterRealtimeRegisters confirms Register plugs the
// "text-doc" kind into the core realtime registry, and that the
// registered closure rejects nil auth without touching the DB. This
// mirrors calc/server/realtime_authorize_test.go.
func TestRegisterRealtimeRegisters(t *testing.T) {
	t.Cleanup(realtime.ResetRegistryForTest)

	app := pocketbase.New()
	Register(app)

	authorize := realtime.LookupForTest(roomKindText)
	if authorize == nil {
		t.Fatalf("Register did not register the %q room kind", roomKindText)
	}

	if err := authorize(nil, "any-drive-item-id"); !errors.Is(err, driveshare.ErrNoAccess) {
		t.Fatalf("nil auth: expected ErrNoAccess, got %v", err)
	}
}

// TestRegisterRealtimeDuplicatePanics confirms calling Register twice
// surfaces as a panic from realtime.RegisterRoomKindWith. Guards
// against accidental double-init at startup.
func TestRegisterRealtimeDuplicatePanics(t *testing.T) {
	t.Cleanup(realtime.ResetRegistryForTest)

	app := pocketbase.New()
	Register(app)

	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic on duplicate RegisterRoomKindWith")
		}
	}()
	Register(app)
}

// TestAuthorize_DeniesNilAuth: a nil auth record must always be
// rejected; this is the unauthenticated-WS-upgrade guard.
func TestAuthorize_DeniesNilAuth(t *testing.T) {
	app := setupAuthTestApp(t)
	authFn := makeAuthorize(app)
	if err := authFn(nil, "any-id"); err == nil {
		t.Error("expected error for nil auth")
	} else if !errors.Is(err, driveshare.ErrNoAccess) {
		t.Errorf("nil auth: want ErrNoAccess, got %v", err)
	}
}

// TestAuthorize_DeniesEmptyAuthID: an auth record with a blank Id
// (paranoia — this should never happen with a real PB user) must be
// treated the same as nil.
func TestAuthorize_DeniesEmptyAuthID(t *testing.T) {
	app := setupAuthTestApp(t)
	authFn := makeAuthorize(app)
	users, err := app.FindCollectionByNameOrId("_superusers")
	if err != nil {
		t.Fatalf("find _superusers: %v", err)
	}
	emptyAuth := core.NewRecord(users)
	if err := authFn(emptyAuth, "any-id"); err == nil {
		t.Error("expected error for empty auth Id")
	}
}

// TestAuthorize_DeniesMissingShares: an authenticated user with no
// drive_shares row for the requested item is denied.
func TestAuthorize_DeniesMissingShares(t *testing.T) {
	app := setupAuthTestApp(t)
	user := mustCreateUser(t, app, "alice@example.com")
	item := seedSharedItem(t, app, nil, "doc.docx")

	authFn := makeAuthorize(app)
	err := authFn(user, item.Id)
	if !errors.Is(err, driveshare.ErrNoAccess) {
		t.Errorf("missing shares: want ErrNoAccess, got %v", err)
	}
}

// TestAuthorize_DeniesNonExistentItem: a request for a drive_item that
// doesn't exist is denied with errNoShare (not a DB error).
func TestAuthorize_DeniesNonExistentItem(t *testing.T) {
	app := setupAuthTestApp(t)
	user := mustCreateUser(t, app, "alice@example.com")

	authFn := makeAuthorize(app)
	err := authFn(user, "nonexistent-item-id")
	if !errors.Is(err, driveshare.ErrNoAccess) {
		t.Errorf("nonexistent item: want ErrNoAccess, got %v", err)
	}
}

// TestAuthorize_GrantsEditor: an editor share row in the item's org
// grants access (no error from authorize).
func TestAuthorize_GrantsEditor(t *testing.T) {
	app := setupAuthTestApp(t)
	user := mustCreateUser(t, app, "alice@example.com")
	item := seedSharedItem(t, app, nil, "doc.docx")
	seedShare(t, app, item.Id, user.Id, "editor")

	authFn := makeAuthorize(app)
	if err := authFn(user, item.Id); err != nil {
		t.Errorf("editor share: want nil, got %v", err)
	}
}

// TestAuthorize_GrantsViewer: a viewer share row grants admission
// (read-only is enforced separately via isReadOnlyForConn, not here).
func TestAuthorize_GrantsViewer(t *testing.T) {
	app := setupAuthTestApp(t)
	user := mustCreateUser(t, app, "alice@example.com")
	item := seedSharedItem(t, app, nil, "doc.docx")
	seedShare(t, app, item.Id, user.Id, "viewer")

	authFn := makeAuthorize(app)
	if err := authFn(user, item.Id); err != nil {
		t.Errorf("viewer share: want nil, got %v", err)
	}
}

// The cross-org staleness test that lived here was deleted rather than
// adapted: single-org has no second org for a share to be stale
// against. The property it guarded — a departed member's grants not
// surviving — is now userorg.OffboardUser's, which has its own tests.
//
// TestResolveShareRole_PicksHighestPrivilege also went away: role
// resolution moved to core/driveshare, which unit-tests the full
// owner > editor > viewer ladder against synthetic collections.

// TestIsReadOnlyForConn covers the read-only signal that gets shipped
// in MsgServerHello. owner/editor → false; viewer → true; missing
// share or empty auth → true (fail closed).
func TestIsReadOnlyForConn(t *testing.T) {
	app := setupAuthTestApp(t)
	editor := mustCreateUser(t, app, "editor@example.com")
	viewer := mustCreateUser(t, app, "viewer@example.com")
	owner := mustCreateUser(t, app, "owner@example.com")
	stranger := mustCreateUser(t, app, "stranger@example.com")
	item := seedSharedItem(t, app, nil, "doc.docx")

	seedShare(t, app, item.Id, editor.Id, "editor")
	seedShare(t, app, item.Id, viewer.Id, "viewer")
	seedShare(t, app, item.Id, owner.Id, "owner")
	// stranger has no share

	cases := []struct {
		name   string
		authID string
		wantRO bool
	}{
		{"editor", editor.Id, false},
		{"owner", owner.Id, false},
		{"viewer", viewer.Id, true},
		{"stranger", stranger.Id, true},
		{"empty-auth", "", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			conn := realtime.NewClientForTest(c.authID)
			if got := isReadOnlyForConn(app, item.Id, conn); got != c.wantRO {
				t.Errorf("isReadOnlyForConn(%s): got %v, want %v", c.name, got, c.wantRO)
			}
		})
	}
}

// The canWrite predicate moved to core/driveshare (Role.CanWrite) and
// is unit-tested there, including the unknown-role fail-closed case.
