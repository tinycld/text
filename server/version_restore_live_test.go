package text

import (
	"context"
	"strings"
	"testing"

	ycrdt "github.com/skyterra/y-crdt"

	"tinycld.org/packages/text/translate"
)

// A restore on an open document must reach the people editing it: the
// returned delta, applied to a peer that holds the newer document, leaves
// that peer with the restored content only. Merging the old Yjs state
// cannot do this — a CRDT merge only adds.
func TestReplaceContentFromDocx_PeerConvergesOnRestoredContent(t *testing.T) {
	live := ycrdt.NewDoc("restore-live", false, nil, nil, false)
	installYXmlElementPatcher(live)
	pm, _, _, err := translate.DocxToPMJSONWithSuggestions(context.Background(), docxWithText(t, "newer text"))
	if err != nil {
		t.Fatal(err)
	}
	if err := translate.SeedFromPMJSON(live, pm); err != nil {
		t.Fatal(err)
	}
	peer := ycrdt.NewDoc("restore-peer", false, nil, nil, false)
	installYXmlElementPatcher(peer)
	ycrdt.ApplyUpdate(peer, ycrdt.EncodeStateAsUpdate(live, nil), nil)

	handle := &textDocHandle{runtime: NewRuntime(), id: "restore-live", doc: live, lastActivity: now()}
	delta, err := handle.replaceContentFromDocx(context.Background(), docxWithText(t, "older text"))
	if err != nil {
		t.Fatal(err)
	}
	ycrdt.ApplyUpdate(peer, delta, nil)

	out, err := translate.PMJSONFromYDoc(peer)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), "older text") || strings.Contains(string(out), "newer text") {
		t.Fatalf("peer doc = %s", out)
	}
}

func TestReplaceContentFromDocx_ClosedHandle(t *testing.T) {
	handle := &textDocHandle{runtime: NewRuntime(), id: "restore-closed", closed: true}
	if _, err := handle.replaceContentFromDocx(context.Background(), docxWithText(t, "x")); err == nil {
		t.Fatal("expected an error on a closed handle")
	}
}
