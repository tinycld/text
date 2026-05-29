package text

import (
	"fmt"
	"log/slog"
	"sync"
	"time"

	ycrdt "github.com/skyterra/y-crdt"

	"tinycld.org/core/realtime"
	"tinycld.org/packages/text/translate"
)

// Janitor / TTL knobs. Package-level vars (not consts) so tests can
// drop them to milliseconds and observe eviction without slow sleeps.
//
// JanitorInterval — how often the janitor wakes to scan registries.
// MaxIdleDuration — docs with no ApplyUpdate / EncodeStateAsUpdate
// activity for this long are forcibly Close()d to bound memory.
// ImportWarningsTTL — bootstrap warnings that no joiner has popped
// after this long are dropped (otherwise a doc that's bootstrapped but
// never opened leaks a slice of warnings forever).
// MaxImportWarningRooms — hard ceiling on the warnings map; oldest
// entry is evicted on overflow.
var (
	JanitorInterval       = 5 * time.Minute
	MaxIdleDuration       = 30 * time.Minute
	ImportWarningsTTL     = 1 * time.Hour
	MaxImportWarningRooms = 256
)

// MaxApplyUpdateBytes bounds the size of a single MsgDocUpdate payload
// the broker is willing to fold into a room's Y.Doc. y-crdt's
// ApplyUpdate allocates per-message; a hostile or buggy client sending
// a 100 MiB frame would exhaust memory before the recover guard
// triggers. Real edits are kilobytes — even a paste of a long document
// rarely exceeds 100 KiB. 1 MiB leaves comfortable headroom for any
// legitimate edit while keeping a single frame's allocation bounded.
const MaxApplyUpdateBytes = 1 * 1024 * 1024

// now is the clock the runtime / janitor read. Replaced in tests to
// drive the TTL paths deterministically without sleeping.
var now = time.Now

// Runtime is the text package's server-side Y.Doc registry. One per
// process; the broker calls NewDoc once per active room and the
// returned handle owns the room's mirror until Close.
//
// Backed by github.com/skyterra/y-crdt (a native-Go yjs decoder /
// encoder). Operations on a single Y.Doc serialize through that doc's
// own internal state machine; the per-room mutex below only guards the
// docs map itself.
type Runtime struct {
	// bootstrap, when non-nil, runs synchronously inside NewDoc with
	// the freshly-minted Y.Doc. Production wires this to load the
	// drive_items docx and seed it into the doc, so the broker's
	// first SyncReply already carries populated content. Tests leave
	// it nil — they construct doc state via ApplyUpdate.
	bootstrap func(roomID string, doc *ycrdt.Doc) error

	mu      sync.Mutex
	docs    map[string]*ycrdt.Doc
	handles map[string]*textDocHandle
	// rooms records the *realtime.Room reference the broker hands us
	// in OnRoomCreate, so server-originated broadcasts (Phase 3a
	// authorship stamping) can call Room.PublishDocUpdate without
	// going through the broker registry each time. Indexed by the same
	// roomID the doc / handle maps use.
	rooms map[string]*realtime.Room

	// editBuffers holds one *editEventBuffer per active room. Constructed
	// in noteRoom alongside the rooms map entry, drained on close. The
	// Phase 3b stamper-adjacent path calls BufferFor(roomID).Note(...)
	// after the authorship stamp succeeds; the buffer's per-clientID
	// timer fires the flush callback wired by makeEditEventFlush, which
	// in turn calls handle.publishEditEvent + room.PublishDocUpdate.
	editBuffers map[string]*editEventBuffer

	// authorship is the Phase 3a stamping cache. Lives the lifetime of
	// the process; per-room state is dropped in closeDoc so a long-
	// running server doesn't leak stamped-set / userOrg memos for
	// rooms that have been evicted.
	authorship *authorshipCache

	// importWarnings holds per-room warnings produced during bootstrap
	// (e.g. tracked changes stripped, comments dropped). The OnConnect
	// ServerHelloFn pops the entry for a freshly-bootstrapping
	// connection's roomID and includes the warnings in MsgServerHello.
	//
	// Entries are time-stamped on insert so the janitor can evict
	// stale rooms whose first joiner never arrived (otherwise a
	// bootstrap-only doc would leak its warnings slice forever).
	importWarningsMu sync.Mutex
	importWarnings   map[string]importWarningEntry

	// janitor goroutine state. stop is closed by Stop() to break the
	// ticker loop; janitorDone signals the goroutine has exited so
	// Stop() can be synchronous. janitorStarted is set by StartJanitor
	// and read by Stop to know whether to wait on janitorDone.
	janitorOnce    sync.Once
	stopOnce       sync.Once
	stop           chan struct{}
	janitorDone    chan struct{}
	janitorStarted bool
	janitorStartMu sync.Mutex
}

// importWarningEntry pairs a warnings slice with the time it was
// inserted so the janitor can evict stale entries past ImportWarningsTTL.
type importWarningEntry struct {
	warnings []translate.Warning
	at       time.Time
}

// NewRuntime returns an empty Runtime. Cheap; no doc state is allocated
// until NewDoc is called. The janitor goroutine is not started here —
// call StartJanitor (production wires this from Register; tests opt
// in selectively).
func NewRuntime() *Runtime {
	return &Runtime{
		docs:           map[string]*ycrdt.Doc{},
		handles:        map[string]*textDocHandle{},
		rooms:          map[string]*realtime.Room{},
		editBuffers:    map[string]*editEventBuffer{},
		authorship:     newAuthorshipCache(),
		importWarnings: map[string]importWarningEntry{},
		stop:           make(chan struct{}),
		janitorDone:    make(chan struct{}),
	}
}

// noteRoom records the *realtime.Room reference the broker hands us
// in its OnRoomCreate callback. The reference lives until closeDoc
// removes it (a room teardown). Used by the Phase 3a authorship
// stamper to broadcast server-originated delta updates back to peers
// via Room.PublishDocUpdate.
//
// Phase 3b additionally constructs the per-room editEventBuffer here.
// The buffer's flush callback closes over the runtime (via
// makeEditEventFlush) and looks up the handle + room at flush time, so
// it stays valid as long as both are alive. Buffer construction is
// cheap (a couple of map allocs); doing it under r.mu keeps the
// invariant "if rooms[roomID] is set, editBuffers[roomID] is too."
func (r *Runtime) noteRoom(roomID string, room *realtime.Room) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.rooms[roomID] = room
	r.editBuffers[roomID] = newEditEventBuffer(roomID, r.makeEditEventFlush())
}

// RoomFor returns the *realtime.Room associated with the given roomID,
// or nil if the room has not been created or has been torn down.
func (r *Runtime) RoomFor(roomID string) *realtime.Room {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.rooms[roomID]
}

// BufferFor returns the *editEventBuffer registered for the given
// roomID, or nil if the room has not been created or has been torn
// down. Pure map lookup under r.mu — the buffer is constructed in
// noteRoom, so a caller observing a non-nil room from RoomFor will
// also observe a non-nil buffer here.
func (r *Runtime) BufferFor(roomID string) *editEventBuffer {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.editBuffers[roomID]
}

// makeEditEventFlush returns the closure the per-room editEventBuffer
// invokes when a window closes. The closure runs in a goroutine spawned
// by time.AfterFunc, so it must be safe to call handleFor + RoomFor
// from any goroutine — both take r.mu and are concurrency-safe.
//
// Lookup-at-flush-time (rather than capturing the handle / room
// pointers at buffer-construction time) means a window that closes
// after the room has been torn down silently drops, since handleFor /
// RoomFor return nil for evicted rooms. Avoids a use-after-close on the
// handle's Y.Doc.
func (r *Runtime) makeEditEventFlush() func(string, EditEvent) {
	return func(roomID string, e EditEvent) {
		handle := r.handleFor(roomID)
		room := r.RoomFor(roomID)
		if handle == nil || room == nil {
			return
		}
		delta, err := handle.publishEditEvent(e)
		if err != nil {
			slog.Error("text: editEvent write failed", "roomID", roomID, "err", err)
			return
		}
		if len(delta) == 0 {
			return
		}
		if err := room.PublishDocUpdate(delta); err != nil {
			slog.Warn("text: editEvent broadcast failed", "roomID", roomID, "err", err)
		}
	}
}

// AuthorshipCache returns the process-wide authorship cache. The
// Phase 3a stamper consults this to short-circuit duplicate work on
// the hot inbound-update path; tests use it to introspect cache state.
func (r *Runtime) AuthorshipCache() *authorshipCache {
	return r.authorship
}

// docFor returns the *ycrdt.Doc registered for the given roomID, or
// nil. Thin accessor — callers should NOT mutate the returned doc
// without holding the handle's mutex. For mutating writes the broker
// goes through textDocHandle.ApplyUpdate; the Phase 3a stamper goes
// through textDocHandle.stampAuthorship. This raw accessor exists for
// the janitor (read-only checks) and integration tests.
func (r *Runtime) docFor(roomID string) *ycrdt.Doc {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.docs[roomID]
}

// handleFor returns the *textDocHandle registered for the given roomID,
// or nil. The Phase 3a authorship stamper uses this to acquire the
// handle's mutex before mutating the doc, so its writes don't race
// with the broker's concurrent ApplyUpdate / EncodeStateAsUpdate calls
// on the same doc.
func (r *Runtime) handleFor(roomID string) *textDocHandle {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.handles[roomID]
}

// StartJanitor spins up the background goroutine that evicts idle docs
// and stale import warnings. Idempotent — subsequent calls are no-ops,
// so it's safe for both Register and tests to call.
func (r *Runtime) StartJanitor() {
	r.janitorOnce.Do(func() {
		r.janitorStartMu.Lock()
		r.janitorStarted = true
		r.janitorStartMu.Unlock()
		go r.janitorLoop()
	})
}

// Stop signals the janitor goroutine to exit and blocks until it has.
// Safe to call even if StartJanitor was never invoked. Idempotent —
// subsequent calls are no-ops.
func (r *Runtime) Stop() {
	r.stopOnce.Do(func() {
		close(r.stop)
	})
	r.janitorStartMu.Lock()
	started := r.janitorStarted
	r.janitorStartMu.Unlock()
	if started {
		<-r.janitorDone
	}
}

// janitorLoop is the background reaper. It wakes on JanitorInterval,
// evicts idle docs (lastActivity older than MaxIdleDuration) and
// import warnings older than ImportWarningsTTL. The loop exits when
// Stop() closes the `stop` channel.
func (r *Runtime) janitorLoop() {
	defer close(r.janitorDone)
	ticker := time.NewTicker(JanitorInterval)
	defer ticker.Stop()
	for {
		select {
		case <-r.stop:
			return
		case <-ticker.C:
			r.evictIdleDocs()
			r.evictStaleImportWarnings()
		}
	}
}

// evictIdleDocs closes every handle whose lastActivity is older than
// MaxIdleDuration.
//
// Lock ordering matters: Close acquires h.mu and then calls
// closeDoc, which acquires r.mu — so taking r.mu first and then
// h.mu (the natural shape for "scan handles") would deadlock.
// Instead we snapshot the handle pointers under r.mu, release it,
// and only then read lastActivity / call Close per handle.
func (r *Runtime) evictIdleDocs() {
	cutoff := now().Add(-MaxIdleDuration)
	r.mu.Lock()
	snapshot := make([]*textDocHandle, 0, len(r.handles))
	for _, h := range r.handles {
		snapshot = append(snapshot, h)
	}
	r.mu.Unlock()
	for _, h := range snapshot {
		if h.LastActivity().Before(cutoff) {
			_ = h.Close()
		}
	}
}

// evictStaleImportWarnings removes entries past ImportWarningsTTL.
// Called by the janitor on the JanitorInterval tick; SetImportWarnings
// also expires entries inline so insertions never see a stale view.
func (r *Runtime) evictStaleImportWarnings() {
	r.importWarningsMu.Lock()
	defer r.importWarningsMu.Unlock()
	r.expireStaleImportWarningsLocked()
}

// SetBootstrap registers a per-room bootstrap hook. NewDoc invokes the
// hook (if set) inside the same critical section that creates the doc,
// so MsgSyncRequest replies are guaranteed to see the populated state.
//
// A nil hook disables bootstrap (for tests). Passing nil after a hook
// has been registered clears it.
func (r *Runtime) SetBootstrap(hook func(roomID string, doc *ycrdt.Doc) error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.bootstrap = hook
}

// NewDoc satisfies realtime.DocRuntime: mints a fresh server-side
// Y.Doc identified by the broker's roomID and returns an opaque
// handle the broker calls into for the room's lifetime.
//
// If a bootstrap hook is registered, it runs synchronously after the
// doc is created. Bootstrap failures are logged but do not abort the
// room creation — a partially-bootstrapped (or empty) doc is preferable
// to refusing the connection, since a peer-driven SyncRequest path
// can still recover.
func (r *Runtime) NewDoc(roomID string) (realtime.DocHandle, error) {
	r.mu.Lock()
	if _, exists := r.docs[roomID]; exists {
		r.mu.Unlock()
		return nil, fmt.Errorf("text: room %s already has a Y.Doc", roomID)
	}
	doc := ycrdt.NewDoc(roomID, false, nil, nil, false)
	installYXmlElementPatcher(doc)
	r.docs[roomID] = doc
	handle := &textDocHandle{runtime: r, id: roomID, doc: doc, lastActivity: now()}
	r.handles[roomID] = handle
	hook := r.bootstrap
	r.mu.Unlock()

	if hook != nil {
		if err := hook(roomID, doc); err != nil {
			slog.Warn("text: bootstrap hook failed; room continues with empty doc",
				"roomID", roomID, "err", err)
		}
	}
	return handle, nil
}

// installYXmlElementPatcher subscribes a `beforeObserverCalls` listener
// on the doc that walks the transaction's Changed / ChangedParentTypes
// maps and patches any YXmlElement (and its embedded YXmlFragment)
// whose EH/DEH/Map are nil. This works around a y-crdt v0.0.0 quirk:
// the library's NewYXmlElement constructor — invoked from
// content_type.go::readYXmlElement during ApplyUpdate decoding —
// returns an element with PrelimAttrs set but EH/DEH/Map left nil.
// When the transaction cleanup then fires observers on the newly
// inserted YXmlElement (e.g. because text was inserted into it),
// CallTypeObservers → CallEventHandlerListeners panics dereferencing
// nil EH.
//
// `beforeObserverCalls` runs after the read phase has populated the
// transaction's Changed map and BEFORE the loop that calls
// CallObserver on each modified type, so patching here ensures every
// observer-firing path sees a valid EventHandler. The seed path
// (translate.SeedFromPMJSON → newXmlElement) already patches the same
// fields for elements it creates explicitly; this hook covers the
// elements y-crdt mints on its own during inbound update decoding.
func installYXmlElementPatcher(doc *ycrdt.Doc) {
	handler := ycrdt.NewObserverHandler(func(args ...interface{}) {
		if len(args) == 0 {
			return
		}
		trans, ok := args[0].(*ycrdt.Transaction)
		if !ok || trans == nil {
			return
		}
		for t := range trans.Changed {
			patchAbstractType(t)
		}
		for t := range trans.ChangedParentTypes {
			patchAbstractType(t)
		}
	})
	doc.On("beforeObserverCalls", handler)
}

// patchAbstractType walks an IAbstractType-shaped value and initializes
// EH/DEH/Map on the embedded AbstractType if they're nil. Type-switches
// over every concrete Y* type readYXmlElement / readYXmlFragment etc.
// might mint during ApplyUpdate decoding. The branch list mirrors the
// typeRefs table in y-crdt's content_type.go.
func patchAbstractType(t interface{}) {
	switch v := t.(type) {
	case *ycrdt.YXmlElement:
		ensureAbstractTypeInitialized(&v.AbstractType)
	case *ycrdt.YXmlFragment:
		ensureAbstractTypeInitialized(&v.AbstractType)
	case *ycrdt.YXmlText:
		ensureAbstractTypeInitialized(&v.AbstractType)
	case *ycrdt.YText:
		ensureAbstractTypeInitialized(&v.AbstractType)
	case *ycrdt.YArray:
		ensureAbstractTypeInitialized(&v.AbstractType)
	case *ycrdt.YMap:
		ensureAbstractTypeInitialized(&v.AbstractType)
	case *ycrdt.YXmlHook:
		ensureAbstractTypeInitialized(&v.AbstractType)
	}
}

func ensureAbstractTypeInitialized(at *ycrdt.AbstractType) {
	if at.EH == nil {
		at.EH = ycrdt.NewEventHandler()
	}
	if at.DEH == nil {
		at.DEH = ycrdt.NewEventHandler()
	}
	if at.Map == nil {
		at.Map = make(map[string]*ycrdt.Item)
	}
}

// closeDoc removes the doc from the registry. Returns true if the
// doc was registered. Safe to call multiple times.
//
// Drops the room reference, the per-room editEventBuffer, and the
// authorship cache's per-room entries alongside the doc/handle so a
// long-running server doesn't leak state for evicted rooms. The
// authorship cache has its own mutex; we release r.mu before calling
// dropRoom to keep the lock ordering (runtime mu → authorship mu, never
// both held).
//
// Phase 3b: the buffer is captured while r.mu is held and then drained
// AFTER unlocking via FlushAll. Draining outside the runtime mutex
// matters because each Flush call invokes the flush callback, which
// takes the handle's mutex via publishEditEvent — holding r.mu across
// that would invert the runtime-mu → handle-mu lock order the rest of
// the file relies on and risk deadlock against ApplyUpdate /
// EncodeStateAsUpdate. FlushAll ensures the final in-flight window for
// each clientID emits before the room dies, so a user who walked away
// mid-session still sees their last edit batch surface in the activity
// feed.
func (r *Runtime) closeDoc(roomID string) bool {
	r.mu.Lock()
	if _, ok := r.docs[roomID]; !ok {
		r.mu.Unlock()
		return false
	}
	delete(r.docs, roomID)
	delete(r.handles, roomID)
	delete(r.rooms, roomID)
	buf := r.editBuffers[roomID]
	delete(r.editBuffers, roomID)
	r.mu.Unlock()
	r.authorship.dropRoom(roomID)
	if buf != nil {
		buf.FlushAll()
	}
	return true
}

// SetImportWarnings records the warnings produced while bootstrapping
// the given room's Y.Doc. Stored on the runtime (not the handle) so the
// OnConnect ServerHelloFn can pop them by roomID without needing the
// broker to thread the handle through.
//
// Called from the bootstrap closure once parse finishes. A subsequent
// PopImportWarnings drains the entry; the janitor evicts entries past
// ImportWarningsTTL to bound the map for rooms whose first joiner
// never arrives. On overflow past MaxImportWarningRooms we drop the
// oldest entry to keep the map size deterministic.
func (r *Runtime) SetImportWarnings(roomID string, warnings []translate.Warning) {
	r.importWarningsMu.Lock()
	defer r.importWarningsMu.Unlock()
	r.expireStaleImportWarningsLocked()
	r.importWarnings[roomID] = importWarningEntry{warnings: warnings, at: now()}
	if len(r.importWarnings) > MaxImportWarningRooms {
		r.evictOldestImportWarningLocked()
	}
}

// expireStaleImportWarningsLocked drops every entry older than
// ImportWarningsTTL. Caller must hold importWarningsMu.
func (r *Runtime) expireStaleImportWarningsLocked() {
	cutoff := now().Add(-ImportWarningsTTL)
	for id, entry := range r.importWarnings {
		if entry.at.Before(cutoff) {
			delete(r.importWarnings, id)
		}
	}
}

// evictOldestImportWarningLocked drops the single oldest entry from
// importWarnings. Caller must hold importWarningsMu.
func (r *Runtime) evictOldestImportWarningLocked() {
	var oldestID string
	var oldestAt time.Time
	first := true
	for id, entry := range r.importWarnings {
		if first || entry.at.Before(oldestAt) {
			oldestID = id
			oldestAt = entry.at
			first = false
		}
	}
	if oldestID != "" {
		delete(r.importWarnings, oldestID)
	}
}

// PopImportWarnings returns and clears the warnings for the given room.
// Returns nil if no warnings were recorded, the entry has already been
// popped, or it expired past ImportWarningsTTL.
//
// The OnConnect handler calls this once per connection. The first
// connection in a freshly-bootstrapped room sees the warnings; later
// joiners see nil — by design, since the warnings describe an import
// event that happened once at room start.
func (r *Runtime) PopImportWarnings(roomID string) []translate.Warning {
	r.importWarningsMu.Lock()
	defer r.importWarningsMu.Unlock()
	entry, ok := r.importWarnings[roomID]
	if !ok {
		return nil
	}
	delete(r.importWarnings, roomID)
	if now().Sub(entry.at) > ImportWarningsTTL {
		return nil
	}
	return entry.warnings
}

// textDocHandle is the broker's handle on one room's server-side Y.Doc.
type textDocHandle struct {
	runtime *Runtime
	id      string

	mu           sync.Mutex
	doc          *ycrdt.Doc // nil after Close
	closed       bool
	lastActivity time.Time // updated on every ApplyUpdate / EncodeStateAsUpdate
}

// LastActivity returns the timestamp of the most recent ApplyUpdate /
// EncodeStateAsUpdate call. Used by the janitor to decide whether to
// evict the doc as idle. Read under the handle mutex so it's safe
// against concurrent activity updates.
func (h *textDocHandle) LastActivity() time.Time {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.lastActivity
}

// ApplyUpdate folds an inbound MsgDocUpdate payload into the server's
// mirror of the room's Y.Doc.
//
// y-crdt's ApplyUpdate logs and silently returns on malformed bytes
// rather than surfacing a decode error. The defer/recover guards
// against that contract regressing — a future panic-on-bad-input
// change in the library would otherwise take down the broker
// goroutine on hostile client input.
func (h *textDocHandle) ApplyUpdate(payload []byte) error {
	if len(payload) > MaxApplyUpdateBytes {
		return fmt.Errorf(
			"text: ApplyUpdate payload %d bytes exceeds cap %d for room %s",
			len(payload), MaxApplyUpdateBytes, h.id,
		)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed || h.doc == nil {
		return fmt.Errorf("text: ApplyUpdate on closed room %s", h.id)
	}
	h.lastActivity = now()
	var applyErr error
	func() {
		defer func() {
			if r := recover(); r != nil {
				applyErr = fmt.Errorf("text: ApplyUpdate panic for room %s: %v", h.id, r)
			}
		}()
		ycrdt.ApplyUpdate(h.doc, payload, nil)
	}()
	return applyErr
}

// stampAuthorship writes the given authorship entries into the
// server-side Y.Doc and returns the bytes of a delta covering only
// those mutations — ready to hand to Room.PublishDocUpdate for
// broadcast.
//
// Synchronizes through the same handle mutex as ApplyUpdate /
// EncodeStateAsUpdate, so server-originated authorship writes don't
// race with concurrent inbound updates routed from other connections.
// The broker's route loop fires per-connection, so two peers writing
// to the same room could otherwise reach the doc simultaneously —
// without this lock, the stamper's authors.Set / firstSeen.Set could
// interleave with the broker's ApplyUpdate, corrupting the doc.
//
// Empty entries returns nil bytes and no error (caller skips the
// broadcast).
func (h *textDocHandle) stampAuthorship(entries []authorshipEntry) ([]byte, error) {
	if len(entries) == 0 {
		return nil, nil
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed || h.doc == nil {
		return nil, fmt.Errorf("text: stampAuthorship on closed room %s", h.id)
	}
	h.lastActivity = now()
	return writeAuthorshipEntries(h.doc, entries)
}

// publishEditEvent writes the given EditEvent into the server-side
// Y.Doc's editEvents Y.Array and returns the bytes of a delta covering
// only that mutation — ready to hand to Room.PublishDocUpdate for
// broadcast.
//
// Synchronizes through the same handle mutex as ApplyUpdate /
// EncodeStateAsUpdate / stampAuthorship, so server-originated edit
// event writes don't race with concurrent inbound updates routed from
// other connections. Mirrors stampAuthorship's mutex pattern.
func (h *textDocHandle) publishEditEvent(event EditEvent) ([]byte, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed || h.doc == nil {
		return nil, fmt.Errorf("text: publishEditEvent on closed room %s", h.id)
	}
	h.lastActivity = now()
	return writeEditEvent(h.doc, event)
}

// EncodeStateAsUpdate returns the bytes a new joiner needs to catch
// up to the room's current state. Wrapped by the broker in a
// MsgSyncReply frame.
func (h *textDocHandle) EncodeStateAsUpdate() ([]byte, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed || h.doc == nil {
		return nil, fmt.Errorf("text: EncodeStateAsUpdate on closed room %s", h.id)
	}
	h.lastActivity = now()
	return ycrdt.EncodeStateAsUpdate(h.doc, nil), nil
}

// Close releases the room's Y.Doc so it can be garbage-collected.
func (h *textDocHandle) Close() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return nil
	}
	h.closed = true
	h.doc = nil
	h.runtime.closeDoc(h.id)
	return nil
}

// readSuggestionsMap reads the document's `suggestions` Y.Map and
// returns the entries as a slice — mirrors the client's
// SuggestionsMap.list() shape. Used by the flush path to thread the
// Yjs-resident metadata (status / resolvedBy / note) through to the
// docx emitter, which embeds it in customXml/tinycld-suggestions.xml
// so a re-import recovers the full state.
//
// Returns nil when the doc has no suggestions root (a fresh doc that's
// never seen a suggestion) — y-crdt's GetMap auto-creates the root key
// on access, so we have to inspect the entries to distinguish empty
// from never-written. Entries with a missing or malformed value type
// are skipped silently; the client's TS layer is the source of truth
// for entry shape, and we don't want a hostile / buggy peer to poison
// the flush.
func readSuggestionsMap(doc *ycrdt.Doc) []translate.SuggestionMapEntry {
	if doc == nil {
		return nil
	}
	m, ok := doc.GetMap("suggestions").(*ycrdt.YMap)
	if !ok {
		return nil
	}
	entries := m.Entries()
	if len(entries) == 0 {
		return nil
	}
	out := make([]translate.SuggestionMapEntry, 0, len(entries))
	for _, v := range entries {
		raw, ok := v.(map[string]any)
		if !ok {
			continue
		}
		out = append(out, translate.SuggestionMapEntry{
			ID:         suggestionFieldString(raw, "id"),
			AuthorID:   suggestionFieldString(raw, "authorId"),
			CreatedAt:  suggestionFieldInt64(raw, "createdAt"),
			Status:     suggestionFieldString(raw, "status"),
			ResolvedBy: suggestionFieldString(raw, "resolvedBy"),
			ResolvedAt: suggestionFieldInt64(raw, "resolvedAt"),
			Note:       suggestionFieldString(raw, "note"),
		})
	}
	return out
}

// suggestionFieldString returns m[k] coerced to string, or "" when the
// key is absent or the value isn't a string. JSON-decoded client maps
// always present string fields as Go string, so a non-string here
// implies a hostile / malformed write — we drop the field rather than
// surface a type assertion panic up the flush chain.
func suggestionFieldString(m map[string]any, k string) string {
	if v, ok := m[k].(string); ok {
		return v
	}
	return ""
}

// suggestionFieldInt64 extracts a numeric field. JS numbers come
// through y-crdt's ContentAny decoder as float64; we also tolerate
// int / int64 in case a future encoder switches.
func suggestionFieldInt64(m map[string]any, k string) int64 {
	switch v := m[k].(type) {
	case float64:
		return int64(v)
	case int64:
		return v
	case int:
		return int64(v)
	case uint64:
		return int64(v)
	}
	return 0
}
