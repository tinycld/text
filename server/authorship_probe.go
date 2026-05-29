package text

import (
	ycrdt "github.com/skyterra/y-crdt"
)

// extractWritingClientIDs decodes an inbound Yjs update payload and
// returns the distinct Yjs clientIDs that wrote any item carried by
// the update.
//
// Implementation: applies the update to a fresh probe doc (same
// pattern as suggestions_authz::validateUpdate) and walks every root
// the apply populated. Each item in each root's blocks has an ID.Client
// field — we collect those into a set and return the keys.
//
// Pure-delete payloads populate the delete set but not the blocks
// list, so they return the empty slice. That is the correct behavior
// for the stamper: deleting items belonging to a clientID we've never
// seen doesn't establish authorship for that clientID.
//
// Malformed input does NOT return an error — the broker's downstream
// ApplyUpdate would also drop the frame on bad bytes; returning empty
// here lets the stamper continue with no-op.
//
// ID.Client is a y-crdt Number (= int) on the wire; we narrow to uint32
// to match Yjs's documented 32-bit clientID space and what the
// authorship entries in the Y.Doc are keyed by elsewhere in this
// package.
func extractWritingClientIDs(update []byte) ([]uint32, error) {
	if len(update) == 0 {
		return nil, nil
	}
	probe := ycrdt.NewDoc("authorship-probe", false, nil, nil, false)
	// Same XmlElement-observer patch the validator installs — without
	// it a legitimate write that triggers observer fan-out during
	// ApplyUpdate would panic, the recover guard would convert that
	// into "no IDs seen", and the stamper would silently skip
	// perfectly valid frames.
	installYXmlElementPatcher(probe)
	if err := applyForProbe(probe, update); err != nil {
		// Convert to "no clientIDs seen" rather than surfacing — the
		// broker's own apply will also reject the bytes; the stamper
		// is a no-op for unstampable frames.
		return nil, nil
	}
	seen := map[uint32]struct{}{}
	for _, root := range probe.Share {
		if root == nil {
			continue
		}
		walkBlocksCollectingClientIDs(root, seen)
	}
	out := make([]uint32, 0, len(seen))
	for cid := range seen {
		out = append(out, cid)
	}
	return out, nil
}

// walkBlocksCollectingClientIDs inspects an AbstractType-bearing root
// and recursively collects ID.Client from every Item in its blocks
// (Start linked-list) and from every Item in nested child types.
//
// Why both Start and Map: Yjs items live either on a positional linked
// list (Start → right → right …) or in a Map keyed by string property
// names (for YMap roots). Both paths reach the same Item struct.
func walkBlocksCollectingClientIDs(root any, seen map[uint32]struct{}) {
	at := embeddedAbstractType(root)
	if at == nil {
		return
	}
	for item := at.Start; item != nil; item = item.Right {
		seen[uint32(item.ID.Client)] = struct{}{}
		if child := nestedTypeOf(item); child != nil {
			walkBlocksCollectingClientIDs(child, seen)
		}
	}
	for _, item := range at.Map {
		if item == nil {
			continue
		}
		seen[uint32(item.ID.Client)] = struct{}{}
		if child := nestedTypeOf(item); child != nil {
			walkBlocksCollectingClientIDs(child, seen)
		}
	}
}

// embeddedAbstractType returns the embedded *ycrdt.AbstractType of a
// concrete Y* value, or nil if the argument isn't a known type. The
// concrete-Y* branch list mirrors the typeRefs table in y-crdt's
// content_type.go (and patchAbstractType in runtime.go) — every
// concrete type the library can mint during update decoding.
//
// The bare *AbstractType branch matters specifically for the probe.
// When ApplyUpdate integrates an item targeting a root key whose
// constructor has never been requested via doc.Get*, y-crdt
// auto-creates a bare *AbstractType placeholder in doc.Share (see
// doc.go::Get) rather than a typed wrapper. Probe docs by definition
// never call Get, so root entries land as bare *AbstractType — that's
// the common case here, not an edge case.
func embeddedAbstractType(t any) *ycrdt.AbstractType {
	switch v := t.(type) {
	case *ycrdt.AbstractType:
		return v
	case *ycrdt.YMap:
		return &v.AbstractType
	case *ycrdt.YArray:
		return &v.AbstractType
	case *ycrdt.YText:
		return &v.AbstractType
	case *ycrdt.YXmlElement:
		return &v.AbstractType
	case *ycrdt.YXmlFragment:
		return &v.AbstractType
	case *ycrdt.YXmlText:
		return &v.AbstractType
	case *ycrdt.YXmlHook:
		return &v.AbstractType
	}
	return nil
}

// nestedTypeOf returns the child IAbstractType-shaped value an Item's
// content might carry (for ContentType — items that hold a nested Y*
// type, e.g. an entry in a YMap whose value is a YMap). Returns nil
// for plain content (text, JSON, binary).
func nestedTypeOf(item *ycrdt.Item) any {
	if item == nil || item.Content == nil {
		return nil
	}
	ct, ok := item.Content.(*ycrdt.ContentType)
	if !ok {
		return nil
	}
	return ct.Type
}
