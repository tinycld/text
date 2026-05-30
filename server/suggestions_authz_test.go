package text

import (
	"testing"

	ycrdt "github.com/skyterra/y-crdt"
)

// buildUpdateBytes is a tiny helper that builds an inbound MsgDocUpdate
// payload by performing mutations on a "source" doc and encoding its
// state. Each test mutates exactly the root keys it cares about and
// hands the bytes to validateUpdate, so the test never reaches into
// validateUpdate's internals — the contract is pure: bytes in, error out.
func buildUpdateBytes(t *testing.T, mutate func(doc *ycrdt.Doc)) []byte {
	t.Helper()
	doc := ycrdt.NewDoc("src", false, nil, nil, false)
	mutate(doc)
	return ycrdt.EncodeStateAsUpdate(doc, nil)
}

// TestValidateUpdate_AllowsNonProtectedRootWrites is the happy path: a
// payload that writes to "default" (the ProseMirror XML fragment) must
// be admitted untouched.
func TestValidateUpdate_AllowsNonProtectedRootWrites(t *testing.T) {
	update := buildUpdateBytes(t, func(doc *ycrdt.Doc) {
		frag := doc.GetXmlFragment("default").(*ycrdt.YXmlFragment)
		text := ycrdt.NewYXmlText()
		if text.Map == nil {
			text.Map = make(map[string]*ycrdt.Item)
		}
		text.Insert(0, "hello", nil)
		frag.Push([]any{text})
	})

	if err := validateUpdate("room-1", update); err != nil {
		t.Fatalf("expected nil error for non-protected write, got %v", err)
	}
}

// TestValidateUpdate_RejectsClientAuthorsWrite verifies the validator
// flags a payload that mutates the clientAuthors map.
func TestValidateUpdate_RejectsClientAuthorsWrite(t *testing.T) {
	update := buildUpdateBytes(t, func(doc *ycrdt.Doc) {
		m := doc.GetMap("clientAuthors").(*ycrdt.YMap)
		m.Set("42", "spoofed-user-id")
	})

	if err := validateUpdate("room-1", update); err == nil {
		t.Fatal("expected error rejecting clientAuthors write, got nil")
	}
}

// TestValidateUpdate_RejectsEditEventsWrite verifies the validator
// flags a payload that mutates the editEvents array.
func TestValidateUpdate_RejectsEditEventsWrite(t *testing.T) {
	update := buildUpdateBytes(t, func(doc *ycrdt.Doc) {
		arr := doc.GetArray("editEvents")
		arr.Push([]any{"spoofed-event"})
	})

	if err := validateUpdate("room-1", update); err == nil {
		t.Fatal("expected error rejecting editEvents write, got nil")
	}
}

// TestValidateUpdate_RejectsClientFirstSeenWrite verifies the validator
// flags a payload that mutates the clientFirstSeen map.
func TestValidateUpdate_RejectsClientFirstSeenWrite(t *testing.T) {
	update := buildUpdateBytes(t, func(doc *ycrdt.Doc) {
		m := doc.GetMap("clientFirstSeen").(*ycrdt.YMap)
		m.Set("42", 12345)
	})

	if err := validateUpdate("room-1", update); err == nil {
		t.Fatal("expected error rejecting clientFirstSeen write, got nil")
	}
}

// TestValidateUpdate_RejectsMixedDefaultPlusProtected verifies the
// validator does NOT let an attacker hide a protected-key write inside
// a payload that also writes the "default" XML fragment legitimately.
// This is the realistic attack shape: a hostile peer would piggy-back
// the spoof on a real edit.
func TestValidateUpdate_RejectsMixedDefaultPlusProtected(t *testing.T) {
	update := buildUpdateBytes(t, func(doc *ycrdt.Doc) {
		frag := doc.GetXmlFragment("default").(*ycrdt.YXmlFragment)
		text := ycrdt.NewYXmlText()
		if text.Map == nil {
			text.Map = make(map[string]*ycrdt.Item)
		}
		text.Insert(0, "legit content", nil)
		frag.Push([]any{text})

		m := doc.GetMap("clientAuthors").(*ycrdt.YMap)
		m.Set("42", "spoofed-user-id")
	})

	if err := validateUpdate("room-1", update); err == nil {
		t.Fatal("expected error rejecting mixed write that touches a protected root, got nil")
	}
}

// TestValidateUpdate_AllowsUnparseablePayload documents the expected
// behavior on malformed input: y-crdt's ApplyUpdate logs-and-returns
// rather than panicking, so garbage bytes produce an empty probe doc
// (no root keys written, nothing to reject). The validator therefore
// admits the frame — the broker's downstream ApplyUpdate will perform
// the same no-op, and a frame that mutates nothing is harmless. If a
// future y-crdt version starts panicking on bad input, the recover
// guard in applyForProbe converts that into a rejection.
func TestValidateUpdate_AllowsUnparseablePayload(t *testing.T) {
	garbage := []byte{0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa}
	if err := validateUpdate("room-1", garbage); err != nil {
		t.Fatalf("expected nil error for unparseable bytes (admit, downstream no-ops), got %v", err)
	}
}
