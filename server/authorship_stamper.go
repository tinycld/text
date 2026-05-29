package text

import (
	"log/slog"

	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/realtime"
)

// makeAuthorshipStamper returns the realtime.OnDocUpdateContent
// callback that stamps clientAuthors / clientFirstSeen for every
// never-before-seen Yjs clientID that authored items in an inbound
// update.
//
// The handler is the orchestrator: it consults the per-room cache,
// extracts clientIDs from the payload, resolves user_org identity,
// writes the entries into the server doc through the handle's
// synchronized stampAuthorship method, captures the delta, and
// broadcasts it. Each sub-step is its own testable unit
// (authorship_{cache,probe,writer}.go), but the wiring lives here.
//
// Skips anonymous (share-link) connections — they don't have a stable
// userOrgID and stamping a placeholder would corrupt downstream
// blame views. The clientID in clientAuthors must round-trip to a
// real user_org record, so we simply don't stamp anonymous edits.
// Phase 3b / 3c renderers will surface anon-clientID items as
// "anonymous" by virtue of having no clientAuthors entry.
//
// All errors are logged but not surfaced — stamping is best-effort.
// A failed stamping just leaves the entry unrecorded; the next frame
// from the same clientID retries.
//
// Concurrency. Runs on the broker's route-path goroutine (per-
// connection). The doc mutation goes through textDocHandle.stampAuthorship,
// which acquires the same mutex the broker's own ApplyUpdate uses, so
// concurrent routes from two peers don't corrupt the shared doc. The
// probe / cache / DB lookups before the doc write are unsynchronized
// (they touch only goroutine-local state or the authorshipCache's own
// mu); the only meaningful serialization is the per-handle mutex
// around the actual doc mutation.
func makeAuthorshipStamper(app core.App, runtime *Runtime) realtime.OnDocUpdateContentFn {
	return func(roomID string, conn *realtime.Client, payload []byte) {
		if conn == nil || conn.IsAnonymous() {
			return
		}
		clientIDs, err := extractWritingClientIDs(payload)
		if err != nil {
			slog.Warn("text: authorship probe failed", "roomID", roomID, "err", err)
			return
		}
		cache := runtime.AuthorshipCache()
		fresh := make([]uint32, 0, len(clientIDs))
		for _, cid := range clientIDs {
			if !cache.alreadyStamped(roomID, cid) {
				fresh = append(fresh, cid)
			}
		}
		if len(fresh) == 0 {
			return
		}
		uoID, ok := cache.lookupUserOrg(roomID, conn.AuthID())
		if !ok {
			resolved, err := resolveUserOrgID(app, conn.AuthID(), roomID)
			if err != nil {
				slog.Warn("text: cannot resolve user_org for stamping",
					"roomID", roomID, "authID", conn.AuthID(), "err", err)
				return
			}
			uoID = resolved
			cache.rememberUserOrg(roomID, conn.AuthID(), uoID)
		}
		handle := runtime.handleFor(roomID)
		room := runtime.RoomFor(roomID)
		if handle == nil || room == nil {
			// Room may have evicted between MsgDocUpdate accept and this
			// hook firing. Drop silently — the next frame from this
			// clientID re-attempts stamping if the doc has been recreated.
			return
		}
		now := nowMS()
		entries := make([]authorshipEntry, 0, len(fresh))
		for _, cid := range fresh {
			entries = append(entries, authorshipEntry{
				ClientID:    cid,
				UserOrgID:   uoID,
				FirstSeenMS: now,
			})
		}
		delta, err := handle.stampAuthorship(entries)
		if err != nil {
			slog.Warn("text: stampAuthorship failed", "roomID", roomID, "err", err)
			return
		}
		if len(delta) == 0 {
			return
		}
		room.PublishDocUpdate(delta)
		// Only mark stamped AFTER successful broadcast — if we noted
		// before publish and PublishDocUpdate silently dropped (e.g.
		// journal append failure), the next frame from this clientID
		// would skip stamping and the entry would be lost.
		for _, cid := range fresh {
			cache.noteStamped(roomID, cid)
		}
	}
}

// nowMS is the broker-wallclock helper. Stored as a var so tests can
// pin it deterministically.
var nowMS = func() int64 {
	return now().UnixMilli()
}
