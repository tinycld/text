package text

import (
	"fmt"

	ycrdt "github.com/skyterra/y-crdt"

	"tinycld.org/core/realtime"
)

// validateUpdate inspects an inbound Yjs update payload and rejects it
// if it mutates any of the Y.Doc root keys reserved for server-stamped
// authorship metadata (realtime.ProtectedYjsRootKeys —
// clientAuthors, clientFirstSeen, editEvents).
//
// Wired into the broker via realtime.RoomKindOptions.UpdateContentValidator.
// A non-nil return drops the frame: it is not journaled, not applied to
// the server-side mirror, and not fanned out to peers.
//
// Probe approach. We apply the update to a fresh, never-touched
// ycrdt.Doc and inspect the resulting Doc.Share map. y-crdt populates
// Share lazily — root types are added either when client code calls
// doc.Get* (which we never do on the probe doc) or when an inbound
// update integrates an item whose parent is that root key. So the keys
// present in probe.Share after ApplyUpdate are EXACTLY the root keys
// the update wrote to. No substring matching, no false positives from
// user content that happens to contain a key name literally — this is
// a structural check directly against the decoded update.
//
// Malformed input. y-crdt's ApplyUpdate logs-and-returns on bad bytes
// rather than panicking, so garbage produces an empty probe (no root
// keys written, nothing to reject). The validator admits such frames —
// the broker's downstream ApplyUpdate performs the same no-op, so a
// frame that mutates nothing is harmless. The recover guard in
// applyForProbe catches the case where a future y-crdt version starts
// panicking on bad input, converting the panic into a rejection
// instead of a goroutine death.
//
// The function is signature-compatible with
// realtime.UpdateContentValidator: (roomID string, update []byte) error.
func validateUpdate(roomID string, update []byte) error {
	probe := ycrdt.NewDoc(roomID+"-probe", false, nil, nil, false)
	installYXmlElementPatcher(probe)

	if err := applyForProbe(probe, update); err != nil {
		return fmt.Errorf("text: validateUpdate could not decode update for room %s: %w", roomID, err)
	}

	for _, key := range realtime.ProtectedYjsRootKeys {
		if probeHasRootKey(probe, key) {
			return fmt.Errorf(
				"text: rejected update for room %s: writes to protected Y.Doc root %q",
				roomID, key,
			)
		}
	}
	return nil
}

// applyForProbe runs ycrdt.ApplyUpdate against a probe doc, recovering
// from any panic the library might raise on malformed input. y-crdt
// today logs-and-returns on bad bytes, but it's defensive to convert
// any future panic into an error so the broker's route-path goroutine
// doesn't die on hostile input.
func applyForProbe(probe *ycrdt.Doc, update []byte) (returnedErr error) {
	defer func() {
		if r := recover(); r != nil {
			returnedErr = fmt.Errorf("ApplyUpdate panic: %v", r)
		}
	}()
	ycrdt.ApplyUpdate(probe, update, nil)
	return nil
}

// probeHasRootKey reports whether the named root key is present in the
// probe doc's Share map. After ApplyUpdate on a never-touched probe,
// Share contains exactly the root keys the update wrote to — no
// auto-creation, no transitive expansion. So a key in Share is a
// structural assertion that the inbound update contained a write
// rooted at that key.
func probeHasRootKey(probe *ycrdt.Doc, key string) bool {
	if probe == nil || probe.Share == nil {
		return false
	}
	_, ok := probe.Share[key]
	return ok
}
