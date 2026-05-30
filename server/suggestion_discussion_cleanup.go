package text

import (
	"log/slog"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
	ycrdt "github.com/skyterra/y-crdt"

	"tinycld.org/core/realtime"
)

// makeSuggestionDiscussionCleanup returns the realtime.OnDocUpdateContent
// callback that soft-deletes text_comments rows whose suggestion_id
// matches a Y.Map suggestion entry that was just removed.
//
// The flow on every accepted MsgDocUpdate:
//  1. Read the current keyset of the doc's `suggestions` Y.Map.
//  2. Diff against the previous snapshot (kept per-room on the runtime).
//  3. For any key present before but absent now, update its text_comments
//     rows: set archived_at = NOW so the live-query filter
//     (archived_at = null) hides them while preserving the historical
//     record for a future "view resolved" surface.
//
// Why this lives on the doc-update path: the client's orphan-auto-delete
// pass (use-suggestion-bridge.web.ts) deletes Y.Map entries via the
// existing collaboration protocol, so the deletion arrives as a regular
// MsgDocUpdate frame the server applies. The frame doesn't carry
// suggestion-table identity; we recover it by comparing pre/post keysets.
//
// Concurrency: runs on the broker's route-path goroutine (per-connection),
// same as the authorship stamper. The keyset read goes through the doc
// directly — Y.Doc ops serialize internally — and the snapshot map is
// guarded by the runtime's mu (same lock used elsewhere for room state).
// The PB writes run synchronously inside the callback; if the table is
// large this could add a few ms to update routing on suggestion delete,
// but the indexed filter (idx_text_comments_suggestion) keeps the query
// O(matching rows).
//
// Errors are logged but not surfaced — cleanup is best-effort. A failed
// archive run leaves the rows un-archived; the next deletion in the same
// room re-attempts diffing against the previous snapshot, but since the
// missing-now-key would already be absent from BOTH snapshot and current
// it won't re-fire. This is by design: the snapshot is updated whether
// or not the archive succeeded, so we don't loop on transient DB errors.
// Operators seeing the log can re-run a manual archive query if needed.
func makeSuggestionDiscussionCleanup(app core.App, runtime *Runtime) realtime.OnDocUpdateContentFn {
	return func(roomID string, _ *realtime.Client, payload []byte) {
		// Fast path: most MsgDocUpdate frames don't touch the
		// `suggestions` Y.Map at all — typing in a doc that has zero
		// suggestions, or a normal text edit in a doc that has some,
		// produces a payload rooted at the `prosemirror` xml fragment.
		// Probe the payload structurally for a write rooted at
		// `suggestions` before doing any of the heavier work below:
		//   - runtime.docFor → r.mu acquisition
		//   - diffSuggestionKeys → r.mu acquisition + m.Keys() walk
		// The probe is the same shape validateUpdate uses; ApplyUpdate
		// against a never-touched probe doc populates Share with
		// exactly the root keys the payload wrote to, so a single
		// map lookup tells us whether suggestions was touched.
		if !payloadTouchesSuggestionsRoot(roomID, payload) {
			return
		}
		doc := runtime.docFor(roomID)
		if doc == nil {
			return
		}
		deleted := runtime.diffSuggestionKeys(roomID, doc)
		if len(deleted) == 0 {
			return
		}
		archiveOrphanedDiscussions(app, deleted)
	}
}

// payloadTouchesSuggestionsRoot returns true iff the inbound Yjs update
// payload contains a write rooted at the `suggestions` Y.Map. Uses the
// same probe technique as validateUpdate (suggestions_authz.go): apply
// the update to a fresh ycrdt.Doc and inspect Share — populated only
// with the root keys the update actually wrote to.
//
// Pure-delete payloads on the suggestions root are a known limitation:
// y-crdt's delete_set references items by (clientID, clock) and never
// calls doc.Get(name), so Share stays empty even though a suggestion
// was deleted. We treat that case as "may touch" and let the full
// diff path run — same fail-open posture as validateUpdate's parallel
// limitation, but here the cost of a false positive is only the
// diffSuggestionKeys call (still cheaper than running it unconditionally
// because the prevSuggestionKeys snapshot stays in sync).
//
// The probe runs ApplyUpdate against a fresh doc, so it's strictly
// per-frame work, but y-crdt's ApplyUpdate is the same code path the
// broker already runs anyway — adding a second pass for the probe is
// roughly the cost of one ApplyUpdate. The gate eliminates a heavier
// r.mu acquisition + m.Keys() walk on every frame that doesn't touch
// suggestions, which is the dominant case.
func payloadTouchesSuggestionsRoot(roomID string, payload []byte) bool {
	probe := ycrdt.NewDoc(roomID+"-cleanup-probe", false, nil, nil, false)
	installYXmlElementPatcher(probe)
	if err := applyForProbe(probe, payload); err != nil {
		// Decode error: be conservative and fall through. The full
		// path is robust to a no-op suggestion diff.
		return true
	}
	if probeHasRootKey(probe, "suggestions") {
		return true
	}
	// Pure-delete payloads (delete_set only) don't populate Share for
	// the deleted root. The check above will miss those. Treat any
	// payload that contained NO Share entries as "may touch" —
	// pessimistic but safe and rare (most updates write SOMETHING).
	if probe.Share == nil || len(probe.Share) == 0 {
		return true
	}
	return false
}

// readSuggestionKeySet returns the set of keys currently present in the
// doc's `suggestions` Y.Map. Returns an empty (non-nil) set when the doc
// has no suggestions root or the root is empty — y-crdt's GetMap
// auto-creates the root on access, so an empty key list is the correct
// "no suggestions" signal.
//
// Companion to readSuggestionsMap (above in runtime.go) — that one
// returns full entries for the flush path; this one returns only the
// keyset for the delete-detection diff. Separate helper because the
// flush path's tolerance for malformed entries differs from ours: a
// suggestion with a missing id is "still a row" for delete detection,
// even if its body content is unusable for docx export.
func readSuggestionKeySet(doc *ycrdt.Doc) map[string]struct{} {
	out := map[string]struct{}{}
	if doc == nil {
		return out
	}
	m, ok := doc.GetMap("suggestions").(*ycrdt.YMap)
	if !ok {
		return out
	}
	for _, k := range m.Keys() {
		out[k] = struct{}{}
	}
	return out
}

// diffSuggestionKeys snapshots the current `suggestions` Y.Map keyset
// for the given room, diffs it against the previous snapshot, returns
// the list of keys that were removed since the last call, and stores
// the new snapshot for the next round.
//
// First call for a given roomID (no prior snapshot): treats every
// currently-present key as the baseline (no keys reported deleted).
// Subsequent calls compute the symmetric difference (prev \ current)
// and store current as the new baseline.
//
// The snapshot map is keyed by roomID and grows by exactly one entry
// per active room. closeDoc removes the entry when the room is torn
// down (see runtime.go::closeDoc — the dropRoomSnapshot call below).
func (r *Runtime) diffSuggestionKeys(roomID string, doc *ycrdt.Doc) []string {
	current := readSuggestionKeySet(doc)

	r.mu.Lock()
	prev, hadPrev := r.prevSuggestionKeys[roomID]
	r.prevSuggestionKeys[roomID] = current
	r.mu.Unlock()

	if !hadPrev {
		// First observation for this room. The baseline is whatever the
		// doc happens to contain right now — bootstrap may have seeded
		// suggestions from the docx, journal replay may have applied
		// further mutations, and we have no way to know which of those
		// entries existed before the most recent delete (if any). Report
		// nothing deleted and let subsequent updates diff forward.
		return nil
	}

	var deleted []string
	for k := range prev {
		if _, stillPresent := current[k]; !stillPresent {
			deleted = append(deleted, k)
		}
	}
	return deleted
}

// initSuggestionKeySnapshot seeds the per-room snapshot with the doc's
// current `suggestions` Y.Map keyset. Called from noteRoom so the very
// first OnDocUpdateContent invocation has a baseline to diff against —
// without this, a delete in the first inbound update after room boot
// would be reported as "no prior snapshot" and silently skipped, since
// the diff treats the first observation as the baseline.
//
// The doc passed here is the one freshly minted by NewDoc (already
// bootstrapped from the docx and replayed from the journal at the time
// noteRoom fires from the broker's OnRoomCreate path), so the snapshot
// reflects every suggestion that was persisted before this room boot.
func (r *Runtime) initSuggestionKeySnapshot(roomID string, doc *ycrdt.Doc) {
	keys := readSuggestionKeySet(doc)
	r.mu.Lock()
	defer r.mu.Unlock()
	r.prevSuggestionKeys[roomID] = keys
}

// archiveOrphanedDiscussions finds every text_comments row whose
// suggestion_id matches one of the given ids and stamps archived_at
// with the current wallclock. Soft-delete: the row remains queryable
// (e.g. for a future "resolved discussions" surface) but the live
// drawer query filters on archived_at = null and skips it.
//
// Iterates id by id rather than building one `IN (...)` filter because
// the deletion sets are typically tiny (1-3 ids per frame) and the
// per-id loop keeps the filter language simple. If the deletion volume
// spikes (e.g. a future "delete all resolved" bulk op fires many keys
// in one tx), switching to an `IN` clause is a one-liner refactor.
//
// Errors per id are logged and the loop continues so a partial failure
// (one bad id, transient lock) doesn't abandon the rest of the archive
// pass.
func archiveOrphanedDiscussions(app core.App, ids []string) {
	if len(ids) == 0 {
		return
	}
	now := types.NowDateTime()
	for _, id := range ids {
		rows, err := app.FindRecordsByFilter(
			"text_comments",
			"suggestion_id = {:id} && archived_at = null",
			"",
			0,
			0,
			map[string]any{"id": id},
		)
		if err != nil {
			slog.Warn("text: archive discussion lookup failed",
				"suggestionID", id, "err", err)
			continue
		}
		for _, row := range rows {
			row.Set("archived_at", now)
			if err := app.Save(row); err != nil {
				slog.Warn("text: archive discussion save failed",
					"rowID", row.Id, "suggestionID", id, "err", err)
			}
		}
	}
}
