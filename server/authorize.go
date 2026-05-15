package text

import (
	"errors"

	"github.com/pocketbase/pocketbase/core"
)

// errNoShare is returned when the user has no drive_shares row for the
// requested drive_item. Mirrors calc's denial behavior — text and calc
// both delegate room-admission to drive's permission model.
//
// Distinguishing share roles (viewer vs. editor) happens client-side
// for now; isReadOnlyForConn (in register.go) is the eventual
// server-side enforcement point but is currently a v1 stub.
var errNoShare = errors.New("text: no drive_shares row for this user/item")

// makeAuthorize returns the realtime.AuthorizeFn for "text-doc" rooms.
// roomID is a drive_items.id; the user may join iff they have at least
// one drive_shares row connecting them (via any of their user_org
// records) to the given drive_item.
//
// Mirrors the shape of the PB RLS rule:
//
//	item.drive_shares_via_item.user_org.user ?= @request.auth.id
//
// We do the lookup directly against drive_shares rather than walking
// through drive_items because the room admission only cares whether
// *any* share row exists for this (user, item) pair — role-level
// distinctions are enforced elsewhere (or will be, once
// isReadOnlyForConn is wired up).
func makeAuthorize(app core.App) func(*core.Record, string) error {
	return func(auth *core.Record, roomID string) error {
		if auth == nil || auth.Id == "" {
			return errNoShare
		}
		return checkDriveItemAccess(app, auth.Id, roomID)
	}
}

// checkDriveItemAccess returns nil iff a drive_shares row exists
// connecting userID to driveItemID through any of their user_org
// records. Equivalent to calc's checkDriveItemAccess; both packages
// gate on the same drive permission predicate.
func checkDriveItemAccess(app core.App, userID, driveItemID string) error {
	rows, err := app.FindRecordsByFilter(
		"drive_shares",
		"item = {:item} && user_org.user = {:user}",
		"",
		1,
		0,
		map[string]any{"item": driveItemID, "user": userID},
	)
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return errNoShare
	}
	return nil
}
