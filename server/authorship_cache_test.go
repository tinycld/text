package text

import "testing"

func TestAuthorshipCache_NotedClientIDs(t *testing.T) {
	c := newAuthorshipCache()
	if c.alreadyStamped("room-1", 42) {
		t.Errorf("fresh cache must report 42 as not stamped")
	}
	c.noteStamped("room-1", 42)
	if !c.alreadyStamped("room-1", 42) {
		t.Errorf("after noteStamped, 42 must report stamped")
	}
	// Different room: still unstamped
	if c.alreadyStamped("room-2", 42) {
		t.Errorf("clientID 42 in room-2 must be independent of room-1")
	}
	// Different client in the same room: unstamped
	if c.alreadyStamped("room-1", 7) {
		t.Errorf("clientID 7 in room-1 must be independent of 42")
	}
}

func TestAuthorshipCache_UserOrgMemo(t *testing.T) {
	c := newAuthorshipCache()
	if got, ok := c.lookupUserOrg("room-1", "user-x"); ok || got != "" {
		t.Errorf("fresh lookup must miss; got (%q, %v)", got, ok)
	}
	c.rememberUserOrg("room-1", "user-x", "uo-42")
	if got, ok := c.lookupUserOrg("room-1", "user-x"); !ok || got != "uo-42" {
		t.Errorf("lookup after remember = (%q, %v); want (uo-42, true)", got, ok)
	}
}

func TestAuthorshipCache_DropRoomClears(t *testing.T) {
	c := newAuthorshipCache()
	c.noteStamped("room-1", 42)
	c.rememberUserOrg("room-1", "user-x", "uo-42")
	c.markUnresolvable("room-1", "user-y")
	c.dropRoom("room-1")
	if c.alreadyStamped("room-1", 42) {
		t.Errorf("after dropRoom, stamped set must be cleared")
	}
	if _, ok := c.lookupUserOrg("room-1", "user-x"); ok {
		t.Errorf("after dropRoom, user_org memo must be cleared")
	}
	if c.isUnresolvable("room-1", "user-y") {
		t.Errorf("after dropRoom, unresolvable set must be cleared")
	}
}

func TestAuthorshipCache_Unresolvable(t *testing.T) {
	c := newAuthorshipCache()
	if c.isUnresolvable("room-1", "user-x") {
		t.Errorf("fresh cache must not report user-x unresolvable")
	}
	c.markUnresolvable("room-1", "user-x")
	if !c.isUnresolvable("room-1", "user-x") {
		t.Errorf("after markUnresolvable, user-x must report unresolvable")
	}
	// Per-room scoping: a different room is independent.
	if c.isUnresolvable("room-2", "user-x") {
		t.Errorf("room-2 must be independent of room-1's unresolvable set")
	}
	// Per-authID scoping: a different auth in the same room is independent.
	if c.isUnresolvable("room-1", "user-y") {
		t.Errorf("user-y in room-1 must be independent of user-x")
	}
}
