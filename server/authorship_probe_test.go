package text

import (
	"sort"
	"testing"

	ycrdt "github.com/skyterra/y-crdt"
)

func TestExtractWritingClientIDs_SingleClient(t *testing.T) {
	src := ycrdt.NewDoc("src", false, nil, nil, false)
	installYXmlElementPatcher(src)
	m, _ := src.GetMap("anything").(*ycrdt.YMap)
	m.Set("k", "v")
	update := ycrdt.EncodeStateAsUpdate(src, nil)

	got, err := extractWritingClientIDs(update)
	if err != nil {
		t.Fatalf("extractWritingClientIDs: %v", err)
	}
	if len(got) != 1 {
		t.Errorf("expected 1 client, got %v", got)
	}
}

func TestExtractWritingClientIDs_MultipleClientsInOneUpdate(t *testing.T) {
	// Two source docs with different clientIDs, both mutating the same root.
	a := ycrdt.NewDoc("a", false, nil, nil, false)
	installYXmlElementPatcher(a)
	mA, _ := a.GetMap("x").(*ycrdt.YMap)
	mA.Set("from-a", true)

	b := ycrdt.NewDoc("b", false, nil, nil, false)
	installYXmlElementPatcher(b)
	mB, _ := b.GetMap("x").(*ycrdt.YMap)
	mB.Set("from-b", true)

	// Capture the source clientIDs BEFORE merging, so the assertion
	// catches any regression that returns the right *count* but wrong
	// *identities* (e.g. a seen-set bug that emits the same ID twice).
	wantA := uint32(a.ClientID)
	wantB := uint32(b.ClientID)
	if wantA == wantB {
		t.Fatalf("test precondition failed: two fresh docs minted the same clientID (%d)", wantA)
	}

	// Merge into one doc; encode against an empty SV to get a single
	// update carrying items from BOTH client IDs.
	merged := ycrdt.NewDoc("merged", false, nil, nil, false)
	installYXmlElementPatcher(merged)
	ycrdt.ApplyUpdate(merged, ycrdt.EncodeStateAsUpdate(a, nil), nil)
	ycrdt.ApplyUpdate(merged, ycrdt.EncodeStateAsUpdate(b, nil), nil)
	combined := ycrdt.EncodeStateAsUpdate(merged, nil)

	got, err := extractWritingClientIDs(combined)
	if err != nil {
		t.Fatalf("extractWritingClientIDs: %v", err)
	}
	sort.Slice(got, func(i, j int) bool { return got[i] < got[j] })

	want := []uint32{wantA, wantB}
	sort.Slice(want, func(i, j int) bool { return want[i] < want[j] })
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("expected exact clientIDs %v, got %v", want, got)
	}
}

// TestExtractWritingClientIDs_NestedTypeRecursion exercises the
// nestedTypeOf / walkBlocksCollectingClientIDs recursion path: a
// nested YMap is written *into* a parent YMap key, and the only
// items written by the nested-doc clientID live inside the nested
// type — not at the top level of the parent. If the recursion
// regressed (e.g. nestedTypeOf returned nil, or the walker stopped
// at root depth), the nested clientID would never surface and the
// stamper would mis-attribute the inner write.
func TestExtractWritingClientIDs_NestedTypeRecursion(t *testing.T) {
	// Doc A: build a parent YMap with a nested YMap value. Both the
	// parent key and the nested-type item are authored by clientA.
	a := ycrdt.NewDoc("a", false, nil, nil, false)
	installYXmlElementPatcher(a)
	parentA, _ := a.GetMap("parent").(*ycrdt.YMap)
	nestedA := ycrdt.NewYMap(nil)
	parentA.Set("nested", nestedA)

	// Doc B: load A's state so the parent + nested structure exists
	// at B's clientID's perspective, then write a key INSIDE the
	// nested YMap. The only items carrying clientB live one level
	// down from the root — surfacing clientB requires recursion.
	b := ycrdt.NewDoc("b", false, nil, nil, false)
	installYXmlElementPatcher(b)
	ycrdt.ApplyUpdate(b, ycrdt.EncodeStateAsUpdate(a, nil), nil)
	parentB, _ := b.GetMap("parent").(*ycrdt.YMap)
	nestedFromBVal := parentB.Get("nested")
	nestedFromB, ok := nestedFromBVal.(*ycrdt.YMap)
	if !ok {
		t.Fatalf("expected nested value to be *YMap after merge, got %T", nestedFromBVal)
	}
	nestedFromB.Set("inner", "written-by-b")

	// Capture clientIDs BEFORE encoding, so we can assert exact
	// identity rather than just count.
	wantA := uint32(a.ClientID)
	wantB := uint32(b.ClientID)
	if wantA == wantB {
		t.Fatalf("test precondition failed: two fresh docs minted the same clientID (%d)", wantA)
	}

	// Encode B's full state. The single update payload now carries:
	//   - the parent key item authored by clientA
	//   - the nested-type ContentType item authored by clientA
	//   - the "inner" key item authored by clientB — only reachable
	//     by descending into the nested type via nestedTypeOf.
	combined := ycrdt.EncodeStateAsUpdate(b, nil)

	got, err := extractWritingClientIDs(combined)
	if err != nil {
		t.Fatalf("extractWritingClientIDs: %v", err)
	}
	sort.Slice(got, func(i, j int) bool { return got[i] < got[j] })

	want := []uint32{wantA, wantB}
	sort.Slice(want, func(i, j int) bool { return want[i] < want[j] })
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("expected nested-recursion clientIDs %v, got %v", want, got)
	}
}

func TestExtractWritingClientIDs_PureDelete(t *testing.T) {
	src := ycrdt.NewDoc("src", false, nil, nil, false)
	installYXmlElementPatcher(src)
	m, _ := src.GetMap("anything").(*ycrdt.YMap)
	m.Set("k", "v")
	beforeSV := ycrdt.EncodeStateVector(src, nil, ycrdt.NewUpdateEncoderV1())
	m.Delete("k")
	deleteOnly := ycrdt.EncodeStateAsUpdate(src, beforeSV)

	got, err := extractWritingClientIDs(deleteOnly)
	if err != nil {
		t.Fatalf("extractWritingClientIDs on delete-only: %v", err)
	}
	// Pure-delete payloads carry no items, so no clientIDs are "writing".
	if len(got) != 0 {
		t.Errorf("expected 0 clientIDs on pure-delete update; got %v", got)
	}
}

func TestExtractWritingClientIDs_MalformedBytes(t *testing.T) {
	_, err := extractWritingClientIDs([]byte("not a yjs update at all"))
	// Implementation choice: malformed bytes return no clientIDs and no
	// error. The broker's own ApplyUpdate already drops malformed
	// frames; we don't want the probe to false-alarm. Pin that behavior:
	if err != nil {
		t.Errorf("malformed bytes should not surface an error; got %v", err)
	}
}

// TestExtractWritingClientIDs_IncrementalDelta covers the realistic
// hot-path case: a live keystroke produces an update encoded against
// the SERVER's current state vector, not against an empty SV. Those
// updates carry items whose Origin / RightOrigin reference items the
// probe doc has never seen, so an Integrate-based probe (e.g. one
// that walks Share after ApplyUpdate) would surface zero clientIDs
// because the struct refs land in PendingStructs rather than being
// integrated into Share. The wire-format-only decoder this file ships
// reads the per-client header (numStructs, clientID, clock) WITHOUT
// integrating, so it returns the writing clientID even when the
// referenced items are missing. This test pins that contract — a
// regression to integration-based probing would surface here as a
// clientID count of zero.
func TestExtractWritingClientIDs_IncrementalDelta(t *testing.T) {
	src := ycrdt.NewDoc("src", false, nil, nil, false)
	installYXmlElementPatcher(src)
	m, _ := src.GetMap("ctx").(*ycrdt.YMap)
	m.Set("seed", "v0")
	// Capture the SV at the point both sides are in sync. The next
	// write is encoded against this SV — that's the incremental delta
	// the broker would route on every keystroke after first sync.
	syncedSV := ycrdt.EncodeStateVector(src, nil, ycrdt.NewUpdateEncoderV1())
	m.Set("incremental", "v1")
	delta := ycrdt.EncodeStateAsUpdate(src, syncedSV)

	got, err := extractWritingClientIDs(delta)
	if err != nil {
		t.Fatalf("extractWritingClientIDs on incremental delta: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("expected 1 clientID on incremental delta; got %v", got)
	}
	if want := uint32(src.ClientID); got[0] != want {
		t.Errorf("expected clientID %d, got %d", want, got[0])
	}
}
