package text

import (
	"log/slog"

	"tinycld.org/core/realtime"
)

// makeAuthorshipStamper returns the realtime.OnDocUpdateContent
// callback that stamps clientAuthors / clientFirstSeen for every
// never-before-seen Yjs clientID that authored items in an inbound
// update.
//
// The handler is the orchestrator: it consults the per-room cache,
// extracts clientIDs from the payload, reads the connection's user id,
// writes the entries into the server doc through the handle's
// synchronized stampAuthorship method, captures the delta, and
// broadcasts it. Each sub-step is its own testable unit
// (authorship_{cache,probe,writer}.go), but the wiring lives here.
//
// Skips anonymous (share-link) connections — they have no stable user
// id and stamping a placeholder would corrupt downstream blame views.
// The clientID in clientAuthors must round-trip to a real users record,
// so we simply don't stamp anonymous edits.
// Phase 3b / 3c renderers will surface anon-clientID items as
// "anonymous" by virtue of having no clientAuthors entry.
//
// All errors are logged but not surfaced — stamping is best-effort.
// A failed stamping just leaves the entry unrecorded; the next frame
// from the same clientID retries.
//
// noteStamped is called only if Publish returns nil — a journal-failed
// broadcast leaves clientIDs un-stamped, so the next inbound update
// from that clientID will retry. Without this guard, the broker's
// silent-on-failure (pre-fix) or error-return (post-fix) Publish path
// could mark a clientID stamped even though its authorship entry was
// never persisted, losing the entry forever.
//
// Concurrency. Runs on the broker's route-path goroutine (per-
// connection). The doc mutation goes through textDocHandle.stampAuthorship,
// which acquires the same mutex the broker's own ApplyUpdate uses, so
// concurrent routes from two peers don't corrupt the shared doc. The
// probe / cache / DB lookups before the doc write are unsynchronized
// (they touch only goroutine-local state or the authorshipCache's own
// mu); the only meaningful serialization is the per-handle mutex
// around the actual doc mutation.
func makeAuthorshipStamper(runtime *Runtime) realtime.OnDocUpdateContentFn {
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
		// Single-org: the author IS the authenticated user on this
		// connection. No DB lookup, so no memo and no negative cache —
		// the multi-org resolver that used to map (user, item) through
		// the user_org junction is gone.
		userID := conn.AuthID()
		if userID == "" {
			return
		}
		fresh := make([]uint32, 0, len(clientIDs))
		for _, cid := range clientIDs {
			if !cache.alreadyStamped(roomID, cid) {
				fresh = append(fresh, cid)
			}
		}
		// Phase 3a path: stamp + broadcast for never-stamped clientIDs.
		// Skipped when every probed clientID is already in the stamped
		// cache (idempotent — clientAuthors entries are written once
		// per session). Phase 3b's buffer.Note path runs unconditionally
		// below.
		if len(fresh) > 0 {
			handle := runtime.handleFor(roomID)
			room := runtime.RoomFor(roomID)
			if handle == nil || room == nil {
				// Room may have evicted between MsgDocUpdate accept and
				// this hook firing. Drop silently — the next frame from
				// this clientID re-attempts stamping if the doc has been
				// recreated.
				return
			}
			now := nowMS()
			entries := make([]authorshipEntry, 0, len(fresh))
			for _, cid := range fresh {
				entries = append(entries, authorshipEntry{
					ClientID:    cid,
					UserID:      userID,
					FirstSeenMS: now,
				})
			}
			delta, err := handle.stampAuthorship(entries)
			if err != nil {
				// Error (not Warn) because writeAuthorshipEntries only
				// fails when the doc's protected roots ("clientAuthors"
				// / "clientFirstSeen") cannot be obtained — that's
				// corruption of the server-side Y.Doc, not a transient
				// issue. An operator seeing this log should investigate
				// the doc's structure, not assume it'll auto-recover.
				slog.Error("text: stampAuthorship failed", "roomID", roomID, "err", err)
				return
			}
			if len(delta) > 0 {
				if err := room.PublishDocUpdate(delta); err != nil {
					slog.Warn("text: authorship broadcast failed; not marking stamped",
						"roomID", roomID, "err", err)
					return
				}
				// Only mark stamped AFTER successful broadcast — if we
				// noted before publish and PublishDocUpdate dropped
				// (e.g. journal append failure), the next frame from
				// this clientID would skip stamping and the entry would
				// be lost.
				for _, cid := range fresh {
					cache.noteStamped(roomID, cid)
				}
			}
		}
		// Phase 3b path: feed every probe-extracted clientID into the
		// per-room editEvent buffer, including ones already stamped by
		// Phase 3a. Edit-event windowing is per-frame (debounced 60s
		// after the last observed update from a clientID), so unlike
		// the idempotent authorship stamp it must run on every inbound
		// frame regardless of cache state.
		//
		// ── Read-only design decision (audience gate) ────────────────
		// editEvents are an audience-facing artifact: their consumers
		// are the activity tab + notify hooks for OTHER writer-class
		// peers. By design (see the screen-level comment in
		// text/tinycld/text/screens/[id].tsx), read-only viewers do not
		// see activity/comments/suggestions. When the only currently-
		// connected writer is the sender themselves — i.e. a solo
		// author editing in private, possibly with read-only viewers
		// watching — the buffer's debounce window would still produce
		// per-clientID entries that nobody else can consume, bloating
		// the WAL and the doc's editEvents Y.Array. Skip the Note
		// when no other writer is present. Discussed in
		// https://github.com/tinycld/text/pull/8 review.
		buffer := runtime.BufferFor(roomID)
		room := runtime.RoomFor(roomID)
		if buffer != nil && room != nil && room.HasOtherWriter(conn) {
			for _, cid := range clientIDs {
				buffer.Note(cid, userID, nil)
			}
		}
	}
}

// nowMS is the broker-wallclock helper. Stored as a var so tests can
// pin it deterministically.
var nowMS = func() int64 {
	return now().UnixMilli()
}
