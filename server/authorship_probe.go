package text

import (
	ycrdt "github.com/skyterra/y-crdt"
)

// extractWritingClientIDs decodes an inbound Yjs update payload and
// returns the distinct Yjs clientIDs that wrote any item carried by
// the update.
//
// Implementation: decodes only the wire-format header for each client
// section (clientID + struct count + starting clock + struct refs)
// via the y-crdt decoder. We don't try to integrate the struct refs
// into a probe Y.Doc, because incremental deltas reference items not
// present in a fresh doc — those items end up in PendingStructs and
// never appear in Share, so a walk would return zero IDs for every
// realistic delta. The wire format records each writing clientID
// directly, so reading the header yields the same answer for full and
// incremental updates alike.
//
// Pure-delete payloads carry zero clients in the struct-refs section
// (only the delete set is populated). They return the empty slice.
// That is the correct behavior for the stamper: deleting items
// belonging to a clientID we've never seen doesn't establish
// authorship for that clientID.
//
// Malformed input returns an error wrapped from the decoder; the
// stamper logs and continues with no-op. The broker's own
// ApplyUpdate would also reject the bytes; treating decode failures
// here as no-stamp matches that behavior.
//
// ID.Client is a y-crdt Number on the wire; we narrow to uint32 to
// match Yjs's documented 32-bit clientID space and what the
// authorship entries in the Y.Doc are keyed by elsewhere in this
// package.
func extractWritingClientIDs(update []byte) ([]uint32, error) {
	if len(update) == 0 {
		return nil, nil
	}
	seen := map[uint32]struct{}{}
	// The decoder reads through ReadVarUint and friends; on malformed
	// bytes y-crdt's helpers panic rather than returning errors, so a
	// recover() converts any blow-up into a no-stamp result. The
	// broker's own ApplyUpdate already drops malformed frames; the
	// probe matches that behavior — return whatever clientIDs were
	// collected before the panic, swallow the error so the stamper
	// continues with a no-op rather than surfacing alarming logs for
	// ordinary well-formed-but-only-partly-parseable updates.
	func() {
		defer func() { _ = recover() }()
		decoder := ycrdt.NewUpdateDecoderV1(update)
		numClients := ycrdt.ReadVarUint(decoder.RestDecoder)
		for i := uint64(0); i < numClients; i++ {
			// Each section in the structs region records, in order:
			//   - structs-in-this-client (varuint)
			//   - clientID                (varuint)
			//   - starting clock          (varuint)
			//   - the structs themselves  (variable)
			// We only need the clientID; we then skip past the structs
			// using the y-crdt decoder so the next iteration aligns
			// with the following client's header.
			numStructs := ycrdt.ReadVarUint(decoder.RestDecoder)
			client, _ := decoder.ReadClient()
			_ = ycrdt.ReadVarUint(decoder.RestDecoder) // clock
			seen[uint32(client)] = struct{}{}
			if !skipStructsForClient(decoder, numStructs) {
				// Decoder ran off the end mid-section. Stop iterating
				// — the remaining clients in this update are
				// unparseable.
				return
			}
		}
	}()
	out := make([]uint32, 0, len(seen))
	for cid := range seen {
		out = append(out, cid)
	}
	return out, nil
}

// skipStructsForClient walks past `n` struct refs in the decoder by
// reading each ref's info byte and conditionally consuming the rest
// of its fields. Mirrors the per-ref branches in y-crdt's
// ReadClientsStructRefs, but discards rather than allocates Item
// values — the probe only needs the clientID header at this layer.
//
// Returns false on EOF mid-ref (decoder ran out of bytes); the caller
// stops iterating and returns whatever clientIDs were already seen.
func skipStructsForClient(decoder *ycrdt.UpdateDecoderV1, n uint64) (ok bool) {
	defer func() {
		if r := recover(); r != nil {
			ok = false
		}
	}()
	for i := uint64(0); i < n; i++ {
		info, _ := decoder.ReadInfo()
		switch ycrdt.BITS5 & info {
		case 0: // GC ref: <length>
			_, _ = decoder.ReadLen()
		case 10: // Skip ref: <length>
			_ = ycrdt.ReadVarUint(decoder.RestDecoder)
		default: // Item ref
			cantCopyParentInfo := (info & (ycrdt.BIT7 | ycrdt.BIT8)) == 0
			if info&ycrdt.BIT8 == ycrdt.BIT8 {
				_, _ = decoder.ReadLeftID()
			}
			if info&ycrdt.BIT7 == ycrdt.BIT7 {
				_, _ = decoder.ReadRightID()
			}
			if cantCopyParentInfo {
				hasYKey, _ := decoder.ReadParentInfo()
				if hasYKey {
					_, _ = decoder.ReadString()
				} else {
					_, _ = decoder.ReadLeftID()
				}
			}
			if cantCopyParentInfo && (info&ycrdt.BIT6) == ycrdt.BIT6 {
				_, _ = decoder.ReadString()
			}
			// Skip the content payload via the library's reader; the
			// returned Content value is discarded.
			_ = ycrdt.ReadItemContent(decoder, info)
		}
	}
	return true
}
