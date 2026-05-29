package text

import "sync"

// authorshipCache holds per-room in-memory state the Phase 3a stamper
// uses to short-circuit duplicate work on the hot inbound-update path.
//
// Two layers:
//   - stamped: { roomID → set<Yjs clientID> }. A clientID is in the
//     set after we've written its entry into clientAuthors. The next
//     frame from that clientID skips the doc-mutation path entirely.
//   - userOrg: { roomID → { authID → userOrgID } }. Memoizes the
//     PocketBase resolver result so repeated stampings from the same
//     connection skip the DB query.
//
// dropRoom clears both layers for a room; called from the runtime
// janitor when a doc evicts so the cache doesn't leak past the
// room's lifetime.
type authorshipCache struct {
	mu      sync.Mutex
	stamped map[string]map[uint32]struct{}
	userOrg map[string]map[string]string
}

func newAuthorshipCache() *authorshipCache {
	return &authorshipCache{
		stamped: map[string]map[uint32]struct{}{},
		userOrg: map[string]map[string]string{},
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

func (c *authorshipCache) lookupUserOrg(roomID, authID string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if room, ok := c.userOrg[roomID]; ok {
		uoID, found := room[authID]
		return uoID, found
	}
	return "", false
}

func (c *authorshipCache) rememberUserOrg(roomID, authID, userOrgID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	room, ok := c.userOrg[roomID]
	if !ok {
		room = map[string]string{}
		c.userOrg[roomID] = room
	}
	room[authID] = userOrgID
}

func (c *authorshipCache) dropRoom(roomID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.stamped, roomID)
	delete(c.userOrg, roomID)
}
