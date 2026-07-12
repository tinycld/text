package translate

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestCrossEra_WordZeroFixture is the migration safety net for the
// wordZero -> doctaculous export/import rewrite.
//
// cross-era-wordzero.docx was flushed by the ORIGINAL wordZero exporter
// (see the migration handoff) and can never be regenerated once wordZero
// is deleted. cross-era-wordzero.expected.json is how the importer read
// that file at the time. The new (doctaculous-backed) importer MUST read
// the old exporter's output identically — this guards real user documents
// already persisted with wordZero-flushed .docx bodies.
//
// Comparison is structural (parse both into PMNode, re-marshal indented)
// so insignificant key-ordering differences don't create false failures.
func TestCrossEra_WordZeroFixture(t *testing.T) {
	assets := filepath.Join("..", "..", "tests", "assets")

	docxBytes, err := os.ReadFile(filepath.Join(assets, "cross-era-wordzero.docx"))
	if err != nil {
		t.Fatalf("read cross-era fixture: %v", err)
	}
	wantJSON, err := os.ReadFile(filepath.Join(assets, "cross-era-wordzero.expected.json"))
	if err != nil {
		t.Fatalf("read cross-era reference PM: %v", err)
	}

	gotJSON, warnings, err := DocxToPMJSON(docxBytes)
	if err != nil {
		t.Fatalf("DocxToPMJSON on cross-era fixture: %v", err)
	}
	if len(warnings) > 0 {
		t.Errorf("unexpected warnings reading cross-era fixture: %+v", warnings)
	}

	if got, want := normalizePM(t, gotJSON), normalizePM(t, wantJSON); got != want {
		t.Errorf("new importer diverges from wordZero-era reading of the old exporter's output:\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}
}

func normalizePM(t *testing.T, raw []byte) string {
	t.Helper()
	var n PMNode
	if err := json.Unmarshal(raw, &n); err != nil {
		t.Fatalf("unmarshal PM: %v", err)
	}
	out, err := json.MarshalIndent(n, "", "  ")
	if err != nil {
		t.Fatalf("marshal PM: %v", err)
	}
	return string(out)
}
