package text

import (
	"sync"
	"testing"
	"time"
)

// Shortened window so tests complete fast.
func withShortWindow(t *testing.T, d time.Duration) {
	t.Helper()
	orig := WindowDuration
	WindowDuration = d
	t.Cleanup(func() { WindowDuration = orig })
}

func TestEditEventBuffer_SingleWindow_FlushesOnTimer(t *testing.T) {
	withShortWindow(t, 50*time.Millisecond)
	var mu sync.Mutex
	var events []EditEvent
	buf := newEditEventBuffer("room-1", func(_ string, e EditEvent) {
		mu.Lock()
		defer mu.Unlock()
		events = append(events, e)
	})
	buf.Note(42, "uo-A", []EditEventAffectedNode{{NodeID: "p1", Snippet: "hello"}})

	time.Sleep(150 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	e := events[0]
	if e.ClientID != 42 || e.AuthorID != "uo-A" || e.EditCount != 1 {
		t.Errorf("unexpected event: %+v", e)
	}
}

func TestEditEventBuffer_MultipleNotes_ExtendsWindow(t *testing.T) {
	withShortWindow(t, 100*time.Millisecond)
	var mu sync.Mutex
	var events []EditEvent
	buf := newEditEventBuffer("room-1", func(_ string, e EditEvent) {
		mu.Lock()
		defer mu.Unlock()
		events = append(events, e)
	})
	buf.Note(42, "uo-A", nil)
	time.Sleep(30 * time.Millisecond)
	buf.Note(42, "uo-A", nil)
	time.Sleep(30 * time.Millisecond)
	buf.Note(42, "uo-A", nil)

	time.Sleep(250 * time.Millisecond) // past the extended window
	mu.Lock()
	defer mu.Unlock()
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if got := events[0].EditCount; got != 3 {
		t.Errorf("editCount = %d, want 3", got)
	}
}

func TestEditEventBuffer_MultipleClientIDsIndependent(t *testing.T) {
	withShortWindow(t, 50*time.Millisecond)
	var mu sync.Mutex
	var events []EditEvent
	buf := newEditEventBuffer("room-1", func(_ string, e EditEvent) {
		mu.Lock()
		defer mu.Unlock()
		events = append(events, e)
	})
	buf.Note(42, "uo-A", nil)
	buf.Note(43, "uo-B", nil)

	time.Sleep(150 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(events))
	}
	gotIDs := map[uint32]bool{}
	for _, e := range events {
		gotIDs[e.ClientID] = true
	}
	if !gotIDs[42] || !gotIDs[43] {
		t.Errorf("missing clientID in events: %v", gotIDs)
	}
}

func TestEditEventBuffer_AffectedNodes_DedupAndCap(t *testing.T) {
	withShortWindow(t, 50*time.Millisecond)
	var mu sync.Mutex
	var events []EditEvent
	buf := newEditEventBuffer("room-1", func(_ string, e EditEvent) {
		mu.Lock()
		defer mu.Unlock()
		events = append(events, e)
	})
	buf.Note(42, "uo-A", []EditEventAffectedNode{
		{NodeID: "p1", Snippet: "a"},
		{NodeID: "p2", Snippet: "b"},
		{NodeID: "p3", Snippet: "c"},
		{NodeID: "p4", Snippet: "d"}, // exceeds cap
		{NodeID: "p5", Snippet: "e"}, // exceeds cap
	})
	buf.Note(42, "uo-A", []EditEventAffectedNode{
		{NodeID: "p1", Snippet: "a"}, // duplicate
		{NodeID: "p6", Snippet: "f"}, // would extend but cap reached
	})

	time.Sleep(150 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	nodes := events[0].AffectedNodes
	if len(nodes) != 3 {
		t.Errorf("affectedNodes length = %d, want 3 (capped)", len(nodes))
	}
	got := map[string]bool{}
	for _, n := range nodes {
		got[n.NodeID] = true
	}
	if !got["p1"] || !got["p2"] || !got["p3"] {
		t.Errorf("expected first 3 nodes; got %v", got)
	}
}

func TestEditEventBuffer_FlushAll_DrainsAllWindows(t *testing.T) {
	withShortWindow(t, 30*time.Second) // long, so timer doesn't fire
	var mu sync.Mutex
	var events []EditEvent
	buf := newEditEventBuffer("room-1", func(_ string, e EditEvent) {
		mu.Lock()
		defer mu.Unlock()
		events = append(events, e)
	})
	buf.Note(42, "uo-A", nil)
	buf.Note(43, "uo-B", nil)

	buf.FlushAll()
	mu.Lock()
	defer mu.Unlock()
	if len(events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(events))
	}
	buf.mu.Lock()
	if len(buf.windows) != 0 {
		t.Errorf("windows not drained: %d remaining", len(buf.windows))
	}
	buf.mu.Unlock()
}
