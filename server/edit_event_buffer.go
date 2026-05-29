package text

import (
	"os"
	"strconv"
	"sync"
	"time"
)

// WindowDuration is the debounce window for editEvents emission.
// Per spec: 60s between observed updates from a clientID closes the
// window and flushes a single EditEvent covering that period.
//
// Overridable via TINYCLD_EDIT_EVENT_WINDOW_MS at process boot.
// The override is read once from Register() via configureWindowFromEnv
// so e2e tests can shorten the window without re-importing the
// package; production leaves the env var unset and gets the 60s
// default. Validates the override is a positive integer; malformed
// or non-positive values leave the default in place.
var WindowDuration = 60 * time.Second

// configureWindowFromEnv reads TINYCLD_EDIT_EVENT_WINDOW_MS and, when
// it parses to a positive integer, overrides WindowDuration. Called
// from Register at server boot. Idempotent — calling it twice with the
// same env var has the same effect as calling it once.
func configureWindowFromEnv() {
	raw := os.Getenv("TINYCLD_EDIT_EVENT_WINDOW_MS")
	if raw == "" {
		return
	}
	ms, err := strconv.Atoi(raw)
	if err != nil || ms <= 0 {
		return
	}
	WindowDuration = time.Duration(ms) * time.Millisecond
}

// SampleNodesPerEvent caps the affectedNodes slice on each event so
// large editing sessions don't bloat the editEvents Y.Array.
// Spec: "a few sample paragraphs," kept at 3.
var SampleNodesPerEvent = 3

// EditEventAffectedNode mirrors the TS type in suggestion-types.ts.
type EditEventAffectedNode struct {
	NodeID  string `json:"nodeId"`
	Snippet string `json:"snippet"`
}

// EditEvent mirrors the TS interface. The broker writes this into the
// editEvents Y.Array on every closed window.
type EditEvent struct {
	ClientID      uint32                  `json:"clientId"`
	AuthorID      string                  `json:"authorId"`
	StartedAt     int64                   `json:"startedAt"`
	EndedAt       int64                   `json:"endedAt"`
	EditCount     int                     `json:"editCount"`
	AffectedNodes []EditEventAffectedNode `json:"affectedNodes"`
}

// editWindow holds the in-flight window for a single clientID. The
// timer fires WindowDuration after the last observed Note; when it
// fires, the window is flushed via the buffer's flush callback.
type editWindow struct {
	authorID      string
	startedAt     int64
	endedAt       int64
	editCount     int
	affectedNodes []EditEventAffectedNode
	timer         *time.Timer
}

// editEventBuffer holds in-flight windows for one room and arranges
// for each clientID's window to flush WindowDuration after the last
// observed update from that clientID.
//
// The buffer does not write to the Y.Doc itself — it invokes the
// `flush` callback, which the runtime wires to a handle.publishEditEvent
// + room.PublishDocUpdate combination. Keeping IO out of the buffer
// lets us unit-test the windowing logic in isolation.
type editEventBuffer struct {
	roomID  string
	flush   func(roomID string, event EditEvent)
	mu      sync.Mutex
	windows map[uint32]*editWindow
}

func newEditEventBuffer(roomID string, flush func(string, EditEvent)) *editEventBuffer {
	return &editEventBuffer{
		roomID:  roomID,
		flush:   flush,
		windows: map[uint32]*editWindow{},
	}
}

// Note records that clientID just authored an update on the doc.
// Called by the OnDocUpdateContent handler after Phase 3a's stamper
// has resolved authorID.
//
// nodeIDs is a sample of the top-level node IDs the doc currently
// holds — we'll trim to SampleNodesPerEvent before emission.
func (b *editEventBuffer) Note(clientID uint32, authorID string, nodeIDs []EditEventAffectedNode) {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := nowMS()
	w := b.windows[clientID]
	if w == nil {
		w = &editWindow{
			authorID:      authorID,
			startedAt:     now,
			endedAt:       now,
			editCount:     1,
			affectedNodes: nodeIDs,
		}
		w.timer = time.AfterFunc(WindowDuration, func() {
			b.Flush(clientID)
		})
		if len(w.affectedNodes) > SampleNodesPerEvent {
			w.affectedNodes = w.affectedNodes[:SampleNodesPerEvent]
		}
		b.windows[clientID] = w
		return
	}
	w.endedAt = now
	w.editCount++
	// Merge sample nodes (dedup by NodeID, cap at SampleNodesPerEvent).
	for _, n := range nodeIDs {
		if len(w.affectedNodes) >= SampleNodesPerEvent {
			break
		}
		alreadyPresent := false
		for _, existing := range w.affectedNodes {
			if existing.NodeID == n.NodeID {
				alreadyPresent = true
				break
			}
		}
		if !alreadyPresent {
			w.affectedNodes = append(w.affectedNodes, n)
		}
	}
	w.timer.Reset(WindowDuration)
}

// Flush closes the window for clientID and invokes the flush callback.
// No-op if no window is in flight for that clientID (e.g. a race
// between the timer firing and a manual Flush call).
//
// The timer is stopped (if still running) so a delayed firing after a
// manual Flush doesn't re-emit. The flush callback runs OUTSIDE the
// mutex so it can take other locks (handle.mu via publishEditEvent)
// without risking deadlock.
func (b *editEventBuffer) Flush(clientID uint32) {
	b.mu.Lock()
	w := b.windows[clientID]
	if w == nil {
		b.mu.Unlock()
		return
	}
	delete(b.windows, clientID)
	if w.timer != nil {
		w.timer.Stop()
	}
	event := EditEvent{
		ClientID:      clientID,
		AuthorID:      w.authorID,
		StartedAt:     w.startedAt,
		EndedAt:       w.endedAt,
		EditCount:     w.editCount,
		AffectedNodes: w.affectedNodes,
	}
	b.mu.Unlock()
	if b.flush != nil {
		b.flush(b.roomID, event)
	}
}

// FlushAll drains every active window. Called on room close to ensure
// the final window of each clientID's session is captured before the
// room's Y.Doc + handle are torn down. After FlushAll, all timers
// are stopped and the windows map is empty.
func (b *editEventBuffer) FlushAll() {
	b.mu.Lock()
	clientIDs := make([]uint32, 0, len(b.windows))
	for cid := range b.windows {
		clientIDs = append(clientIDs, cid)
	}
	b.mu.Unlock()
	for _, cid := range clientIDs {
		b.Flush(cid)
	}
}
