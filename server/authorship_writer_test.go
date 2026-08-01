package text

import (
	"strconv"
	"testing"

	ycrdt "github.com/skyterra/y-crdt"
)

func TestWriteAuthorshipEntries_PopulatesProtectedRoots(t *testing.T) {
	doc := ycrdt.NewDoc("writer-test", false, nil, nil, false)
	installYXmlElementPatcher(doc)
	entries := []authorshipEntry{
		{ClientID: 100, UserID: "user-A", FirstSeenMS: 1700000000000},
		{ClientID: 200, UserID: "user-B", FirstSeenMS: 1700000000001},
	}
	delta, err := writeAuthorshipEntries(doc, entries)
	if err != nil {
		t.Fatalf("writeAuthorshipEntries: %v", err)
	}
	if len(delta) == 0 {
		t.Fatalf("expected non-empty delta bytes")
	}

	// Verify clientAuthors populated
	authors, _ := doc.GetMap("clientAuthors").(*ycrdt.YMap)
	if v := authors.Get(strconv.FormatUint(100, 10)); v != "user-A" {
		t.Errorf("clientAuthors[100] = %v, want user-A", v)
	}
	if v := authors.Get(strconv.FormatUint(200, 10)); v != "user-B" {
		t.Errorf("clientAuthors[200] = %v, want user-B", v)
	}

	// Verify clientFirstSeen populated. y-crdt only accepts its own
	// Number alias (= int) for integer content; the writer narrows
	// int64 → int before Set, so the value comes back as int.
	firstSeen, _ := doc.GetMap("clientFirstSeen").(*ycrdt.YMap)
	if v := firstSeen.Get("100"); v != int(1700000000000) {
		t.Errorf("clientFirstSeen[100] = %v (type %T), want 1700000000000", v, v)
	}
}

func TestWriteAuthorshipEntries_EmptyDeltaWhenNoEntries(t *testing.T) {
	doc := ycrdt.NewDoc("writer-test", false, nil, nil, false)
	installYXmlElementPatcher(doc)
	delta, err := writeAuthorshipEntries(doc, nil)
	if err != nil {
		t.Fatalf("writeAuthorshipEntries: %v", err)
	}
	if len(delta) != 0 {
		t.Errorf("expected empty delta for empty entries, got %d bytes", len(delta))
	}
}

func TestWriteAuthorshipEntries_DeltaApplicableToFreshPeer(t *testing.T) {
	// Server-side doc receives entries and emits delta.
	server := ycrdt.NewDoc("writer-server", false, nil, nil, false)
	installYXmlElementPatcher(server)
	entries := []authorshipEntry{
		{ClientID: 42, UserID: "user-X", FirstSeenMS: 9999},
	}
	delta, _ := writeAuthorshipEntries(server, entries)

	// Fresh peer integrates the delta and observes the same state.
	peer := ycrdt.NewDoc("writer-peer", false, nil, nil, false)
	installYXmlElementPatcher(peer)
	ycrdt.ApplyUpdate(peer, delta, nil)

	peerAuthors, _ := peer.GetMap("clientAuthors").(*ycrdt.YMap)
	if v := peerAuthors.Get("42"); v != "user-X" {
		t.Errorf("peer clientAuthors[42] = %v, want user-X", v)
	}
	peerFirstSeen, _ := peer.GetMap("clientFirstSeen").(*ycrdt.YMap)
	if v := peerFirstSeen.Get("42"); v != int(9999) {
		t.Errorf("peer clientFirstSeen[42] = %v (type %T), want 9999", v, v)
	}
}
