package text

import "testing"

// The user_org memo and the unresolvable negative cache both went away
// with the resolver: single-org reads the author id straight off the
// connection, so there is no DB result to memoize and no lookup that can
// fail. Only the stamped set remains.

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

func TestAuthorshipCache_DropRoomClears(t *testing.T) {
	c := newAuthorshipCache()
	c.noteStamped("room-1", 42)
	c.noteStamped("room-2", 7)
	c.dropRoom("room-1")
	if c.alreadyStamped("room-1", 42) {
		t.Errorf("after dropRoom, stamped set must be cleared")
	}
	// Dropping one room must not disturb another.
	if !c.alreadyStamped("room-2", 7) {
		t.Errorf("dropRoom(room-1) must not clear room-2")
	}
}
