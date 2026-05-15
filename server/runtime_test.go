package text

import (
	"testing"

	"tinycld.org/packages/text/translate"
)

// TestRuntime_NewDocAndClose smoke-tests that we can create and close
// a Y.Doc through the runtime without a bootstrap hook (the test
// path; production always wires a bootstrap).
func TestRuntime_NewDocAndClose(t *testing.T) {
	runtime := NewRuntime()
	handle, err := runtime.NewDoc("test-room")
	if err != nil {
		t.Fatalf("NewDoc: %v", err)
	}
	if handle == nil {
		t.Fatal("NewDoc returned nil DocHandle")
	}
	if err := handle.Close(); err != nil {
		t.Errorf("Close: %v", err)
	}
	// Close should be idempotent — calling twice is not an error.
	if err := handle.Close(); err != nil {
		t.Errorf("second Close: %v", err)
	}
}

// TestRuntime_NewDocDuplicateRejects confirms that a second NewDoc
// for the same roomID fails — the broker should never call NewDoc
// twice for one room, but a guard avoids silently overwriting state
// if it ever does.
func TestRuntime_NewDocDuplicateRejects(t *testing.T) {
	runtime := NewRuntime()
	if _, err := runtime.NewDoc("dup-room"); err != nil {
		t.Fatalf("first NewDoc: %v", err)
	}
	if _, err := runtime.NewDoc("dup-room"); err == nil {
		t.Fatal("expected error on duplicate NewDoc")
	}
}

// TestRuntime_EncodeStateAsUpdateOnEmptyDoc returns non-nil bytes
// even for a fresh doc — y-crdt's state-update for an empty doc is
// a small header that the broker ships verbatim.
func TestRuntime_EncodeStateAsUpdateOnEmptyDoc(t *testing.T) {
	runtime := NewRuntime()
	handle, err := runtime.NewDoc("encode-room")
	if err != nil {
		t.Fatalf("NewDoc: %v", err)
	}
	defer func() { _ = handle.Close() }()

	bytes, err := handle.EncodeStateAsUpdate()
	if err != nil {
		t.Fatalf("EncodeStateAsUpdate: %v", err)
	}
	if bytes == nil {
		t.Fatal("EncodeStateAsUpdate returned nil bytes for empty doc")
	}
}

// TestRuntime_ClosedHandleRejectsOps ensures the broker can't call
// into a closed handle (defense against teardown races).
func TestRuntime_ClosedHandleRejectsOps(t *testing.T) {
	runtime := NewRuntime()
	handle, err := runtime.NewDoc("closed-room")
	if err != nil {
		t.Fatalf("NewDoc: %v", err)
	}
	if err := handle.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if err := handle.ApplyUpdate([]byte{0x00}); err == nil {
		t.Error("ApplyUpdate on closed handle should error")
	}
	if _, err := handle.EncodeStateAsUpdate(); err == nil {
		t.Error("EncodeStateAsUpdate on closed handle should error")
	}
}

// TestRuntime_ImportWarnings round-trips warnings through Set/Pop —
// the OnConnect path's contract.
func TestRuntime_ImportWarnings(t *testing.T) {
	runtime := NewRuntime()
	want := []translate.Warning{
		{Code: translate.WarningTrackedChanges},
		{Code: translate.WarningComments, Detail: "3 comments dropped"},
	}
	runtime.SetImportWarnings("room-1", want)

	got := runtime.PopImportWarnings("room-1")
	if len(got) != 2 {
		t.Fatalf("PopImportWarnings = %d entries, want 2", len(got))
	}
	if got[0].Code != translate.WarningTrackedChanges {
		t.Errorf("got[0].Code = %q, want %q", got[0].Code, translate.WarningTrackedChanges)
	}
	if got[1].Code != translate.WarningComments || got[1].Detail != "3 comments dropped" {
		t.Errorf("got[1] = %+v, want comments + detail", got[1])
	}

	// Pop drains the entry — second call returns nil.
	if got2 := runtime.PopImportWarnings("room-1"); got2 != nil {
		t.Errorf("PopImportWarnings second call = %+v, want nil", got2)
	}
}

// TestRuntime_PopImportWarningsAbsentRoom returns nil for a room
// that never had warnings recorded — the OnConnect handler must
// tolerate this for non-bootstrap connections.
func TestRuntime_PopImportWarningsAbsentRoom(t *testing.T) {
	runtime := NewRuntime()
	if got := runtime.PopImportWarnings("never-set"); got != nil {
		t.Errorf("PopImportWarnings for absent room = %+v, want nil", got)
	}
}
