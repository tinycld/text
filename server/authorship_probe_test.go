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
	if len(got) != 2 {
		t.Errorf("expected 2 clientIDs, got %v", got)
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
