package text

import (
	"errors"
	"fmt"

	"github.com/pocketbase/pocketbase/core"
)

// errNoUserOrg is returned when the connection's user has no
// user_org row matching the item's owning org. Distinct from
// errNoShare (which considers drive_shares); a connection could be
// share-authorized via a different user_org row that happens to point
// at the item. Phase 3a stamping requires the *membership* row (the
// user_org tying user → org), not the per-item permission row, so this
// resolver is intentionally narrower than resolveShareRole.
var errNoUserOrg = errors.New("text: no user_org row tying this user to this item's owning org")

// resolveUserOrgID returns the user_org record ID for the connection's
// user against the drive_item's owning org.
//
// The Phase 3a authorship stamper writes this ID into the clientAuthors
// Y.Doc root keyed by the connection's Yjs clientID, so blame walks can
// later look up "which user_org wrote this character" and resolve a
// display identity (avatar, name).
//
// Why org-scoped: a single PocketBase user may belong to multiple
// orgs. The stamper must record the user_org *for the org that owns
// this doc* — not some other org the user happens to belong to —
// because authorship rendering uses org-scoped profile fields
// (preferred name in this org, avatar within this org's chrome).
//
// Companion to resolveShareRole in authorize.go: that one walks
// drive_shares to decide whether a user may even join; this one walks
// user_org directly to record who authored each frame post-join.
func resolveUserOrgID(app core.App, userID, driveItemID string) (string, error) {
	if userID == "" || driveItemID == "" {
		return "", errNoUserOrg
	}
	item, err := app.FindRecordById("drive_items", driveItemID)
	if err != nil {
		return "", fmt.Errorf("text: resolveUserOrgID could not find drive_item %s: %w", driveItemID, err)
	}
	orgID := item.GetString("org")
	if orgID == "" {
		return "", errNoUserOrg
	}
	rows, err := app.FindRecordsByFilter(
		"user_org",
		"user = {:user} && org = {:org}",
		"",
		1,
		0,
		map[string]any{"user": userID, "org": orgID},
	)
	if err != nil {
		return "", fmt.Errorf("text: resolveUserOrgID lookup failed: %w", err)
	}
	if len(rows) == 0 {
		return "", errNoUserOrg
	}
	return rows[0].Id, nil
}
