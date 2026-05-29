package text

import (
	"testing"

	ycrdt "github.com/skyterra/y-crdt"
)

func TestWriteEditEvent_AppendsToYArray(t *testing.T) {
	doc := ycrdt.NewDoc("writer", false, nil, nil, false)
	installYXmlElementPatcher(doc)
	event := EditEvent{
		ClientID: 42, AuthorID: "uo-A", StartedAt: 1000, EndedAt: 2000, EditCount: 5,
		AffectedNodes: []EditEventAffectedNode{{NodeID: "p1", Snippet: "hello"}},
	}
	delta, err := writeEditEvent(doc, event)
	if err != nil {
		t.Fatalf("writeEditEvent: %v", err)
	}
	if len(delta) == 0 {
		t.Fatalf("expected non-empty delta")
	}
	arr := doc.GetArray("editEvents")
	if arr.Length != 1 {
		t.Errorf("editEvents length = %d, want 1", arr.Length)
	}
}

func TestWriteEditEvent_PrunesPast100(t *testing.T) {
	doc := ycrdt.NewDoc("writer", false, nil, nil, false)
	installYXmlElementPatcher(doc)
	for i := 0; i < 105; i++ {
		event := EditEvent{ClientID: uint32(i), AuthorID: "uo", StartedAt: int64(i), EndedAt: int64(i)}
		if _, err := writeEditEvent(doc, event); err != nil {
			t.Fatalf("writeEditEvent[%d]: %v", i, err)
		}
	}
	arr := doc.GetArray("editEvents")
	if arr.Length != 100 {
		t.Errorf("editEvents length after 105 writes = %d, want 100 (pruned)", arr.Length)
	}
	// The first 5 should have been pruned; the last entry should be clientID=104.
	last := arr.Get(99)
	m, ok := last.(map[string]interface{})
	if !ok {
		t.Fatalf("last entry is not a map: %T", last)
	}
	cid, _ := m["clientId"].(int)
	if cid != 104 {
		t.Errorf("last entry clientID = %v, want 104", m["clientId"])
	}
}

func TestWriteEditEvent_DeltaApplicableToFreshPeer(t *testing.T) {
	server := ycrdt.NewDoc("server", false, nil, nil, false)
	installYXmlElementPatcher(server)
	event := EditEvent{
		ClientID: 99, AuthorID: "uo-X", StartedAt: 100, EndedAt: 200, EditCount: 3,
	}
	delta, _ := writeEditEvent(server, event)

	peer := ycrdt.NewDoc("peer", false, nil, nil, false)
	installYXmlElementPatcher(peer)
	ycrdt.ApplyUpdate(peer, delta, nil)

	peerArr := peer.GetArray("editEvents")
	if peerArr.Length != 1 {
		t.Errorf("peer editEvents length = %d, want 1", peerArr.Length)
	}
}
