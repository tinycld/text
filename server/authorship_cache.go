package text

import "sync"

// authorshipCache holds per-room in-memory state the Phase 3a stamper
// uses to short-circuit duplicate work on the hot inbound-update path.
//
// stamped: { roomID → set<Yjs clientID> }. A clientID is in the set
// after we've written its entry into clientAuthors. The next frame from
// that clientID skips the doc-mutation path entirely.
//
// Single-org: the author id IS the connection's authenticated user id,
// read from conn.AuthID() in memory, so there is no resolver result to
// memoize and no unresolvable state to negative-cache. Both layers went
// away with the user_org junction.
//
// dropRoom clears the room's entry; called from the runtime janitor when
// a doc evicts so the cache doesn't leak past the room's lifetime.
type authorshipCache struct {
	mu      sync.Mutex
	stamped map[string]map[uint32]struct{}
}

func newAuthorshipCache() *authorshipCache {
	return &authorshipCache{
		stamped: map[string]map[uint32]struct{}{},
	}
}

func (c *authorshipCache) alreadyStamped(roomID string, clientID uint32) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if room, ok := c.stamped[roomID]; ok {
		_, found := room[clientID]
		return found
	}
	return false
}

func (c *authorshipCache) noteStamped(roomID string, clientID uint32) {
	c.mu.Lock()
	defer c.mu.Unlock()
	room, ok := c.stamped[roomID]
	if !ok {
		room = map[uint32]struct{}{}
		c.stamped[roomID] = room
	}
	room[clientID] = struct{}{}
}

func (c *authorshipCache) dropRoom(roomID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.stamped, roomID)
}
