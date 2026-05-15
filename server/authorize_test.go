package text

import (
	"errors"
	"testing"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/realtime"
)

// TestRegisterRealtimeRegisters confirms Register plugs the
// "text-doc" kind into the core realtime registry, and that the
// registered closure rejects nil auth without touching the DB. This
// mirrors calc/server/realtime_authorize_test.go.
//
// The share-grant / share-denied paths require populated drive_items +
// drive_shares + user_org schemas — that's the playwright e2e's job.
// Here we just exercise the registry wiring and the cheap rejection
// branches.
func TestRegisterRealtimeRegisters(t *testing.T) {
	t.Cleanup(realtime.ResetRegistryForTest)

	app := pocketbase.New()
	Register(app)

	authorize := realtime.LookupForTest(roomKindText)
	if authorize == nil {
		t.Fatalf("Register did not register the %q room kind", roomKindText)
	}

	if err := authorize(nil, "any-drive-item-id"); !errors.Is(err, errNoShare) {
		t.Fatalf("nil auth: expected errNoShare, got %v", err)
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
	app := setupTestApp(t)
	authFn := makeAuthorize(app)
	if err := authFn(nil, "any-id"); err == nil {
		t.Error("expected error for nil auth")
	} else if !errors.Is(err, errNoShare) {
		t.Errorf("nil auth: want errNoShare, got %v", err)
	}
}

// TestAuthorize_DeniesEmptyAuthID: an auth record with a blank Id
// (paranoia — this should never happen with a real PB user) must be
// treated the same as nil. Guards the explicit `auth.Id == ""` check
// in makeAuthorize that prevents an unauthenticated lookup against
// drive_shares with an empty user filter.
func TestAuthorize_DeniesEmptyAuthID(t *testing.T) {
	app := setupTestApp(t)
	authFn := makeAuthorize(app)
	users, err := app.FindCollectionByNameOrId("_superusers")
	if err != nil {
		t.Fatalf("find _superusers: %v", err)
	}
	emptyAuth := core.NewRecord(users) // not saved → Id is empty
	if err := authFn(emptyAuth, "any-id"); err == nil {
		t.Error("expected error for empty auth Id")
	}
}

// TestAuthorize_DeniesMissingShares: a real authenticated user with
// no drive_shares row for the requested item is denied. The tests
// here use the minimal drive_items collection from setupTestApp; the
// authorize lookup against drive_shares will fail because the test
// app doesn't define the drive_shares collection at all — that's the
// expected v1 behavior (no shares = no access).
//
// Note: the FindRecordsByFilter call returns an error when the
// collection doesn't exist, which propagates out of checkDriveItemAccess.
// Either error or errNoShare counts as "denied" for our purposes;
// what matters is that the function does NOT return nil.
func TestAuthorize_DeniesMissingShares(t *testing.T) {
	app := setupTestApp(t)
	user := mustCreateUser(t, app, "alice@example.com")
	authFn := makeAuthorize(app)
	if err := authFn(user, "some-drive-item-id"); err == nil {
		t.Error("expected error for user with no drive_shares row")
	}
}
