package translate

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestDocxToPMJSON_FeatureTestFixture parses the user-authored
// feature-test.docx fixture and verifies the result against
// feature-test.expected.json. The expected JSON is generated once
// (the first run writes feature-test.expected.json.generated and
// fails) and then reviewed by hand before committing.
func TestDocxToPMJSON_FeatureTestFixture(t *testing.T) {
	fixturePath := filepath.Join("..", "..", "tests", "assets", "feature-test.docx")
	expectedPath := filepath.Join("..", "..", "tests", "assets", "feature-test.expected.json")

	fixture, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	expected, err := os.ReadFile(expectedPath)
	if err != nil {
		actual, _, parseErr := DocxToPMJSON(fixture)
		if parseErr != nil {
			t.Fatalf("parse fixture: %v", parseErr)
		}
		writePath := expectedPath + ".generated"
		_ = os.WriteFile(writePath, prettifyJSON(actual), 0o644)
		t.Fatalf(
			"expected JSON missing at %s.\n"+
				"Wrote actual output to %s — REVIEW BY HAND, then move to %s once correct",
			expectedPath, writePath, expectedPath,
		)
	}

	actual, warnings, err := DocxToPMJSON(fixture)
	if err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	if len(warnings) > 0 {
		t.Errorf("unexpected warnings parsing feature-test.docx: %+v", warnings)
	}

	var actualNode, expectedNode PMNode
	if err := json.Unmarshal(actual, &actualNode); err != nil {
		t.Fatalf("unmarshal actual: %v", err)
	}
	if err := json.Unmarshal(expected, &expectedNode); err != nil {
		t.Fatalf("unmarshal expected: %v", err)
	}
	actualRe, _ := json.MarshalIndent(actualNode, "", "  ")
	expectedRe, _ := json.MarshalIndent(expectedNode, "", "  ")
	if string(actualRe) != string(expectedRe) {
		t.Errorf("DocxToPMJSON output diverges from expected.\nDiff written to %s.diff", expectedPath)
		_ = os.WriteFile(expectedPath+".diff", actualRe, 0o644)
	}
}

// TestDocxToPMJSON_NotADocx returns an error (not a panic) when the
// bytes aren't a valid ZIP archive.
func TestDocxToPMJSON_NotADocx(t *testing.T) {
	_, _, err := DocxToPMJSON([]byte("not a docx file"))
	if err == nil {
		t.Errorf("expected error for non-docx bytes, got nil")
	}
}

// prettifyJSON re-marshals JSON with 2-space indentation so the
// generated file is reviewable.
func prettifyJSON(b []byte) []byte {
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		return b
	}
	out, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return b
	}
	return out
}
