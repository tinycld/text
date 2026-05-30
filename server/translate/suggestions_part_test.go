package translate

import (
	"strings"
	"testing"
)

func TestWriteSuggestionsCustomXML(t *testing.T) {
	spans := []suggestionSpan{
		{DocxRevisionID: 1, Kind: suggestionKindInsert, SuggestionID: "s_alice", AuthorID: "uo_alice", Ts: 1700000000000},
		{DocxRevisionID: 2, Kind: suggestionKindDelete, SuggestionID: "s_bob", AuthorID: "uo_bob", Ts: 1700000010000},
	}
	entries := []SuggestionMapEntry{
		{ID: "s_alice", AuthorID: "uo_alice", CreatedAt: 1700000000000, Status: "open"},
		{ID: "s_bob", AuthorID: "uo_bob", CreatedAt: 1700000010000, Status: "open", Note: "rewrite"},
	}
	xmlBytes, err := writeSuggestionsCustomXML(spans, nil, nil, nil, entries)
	if err != nil {
		t.Fatalf("write: %v", err)
	}
	xml := string(xmlBytes)
	if !strings.Contains(xml, "tinycld-suggestions") {
		t.Errorf("expected root element to mention tinycld-suggestions; got:\n%s", xml)
	}
	if !strings.Contains(xml, `id="s_alice"`) {
		t.Errorf("expected suggestion entry id=s_alice; got:\n%s", xml)
	}
	if !strings.Contains(xml, `revisionId="1"`) {
		t.Errorf("expected docx revision mapping for w:id=1; got:\n%s", xml)
	}
	if !strings.Contains(xml, `status="open"`) {
		t.Errorf("expected status=open; got:\n%s", xml)
	}
	if !strings.Contains(xml, `note="rewrite"`) {
		t.Errorf("expected note attribute on s_bob; got:\n%s", xml)
	}
}

func TestParseSuggestionsCustomXMLRoundtrip(t *testing.T) {
	original := []SuggestionMapEntry{
		{ID: "s_alice", AuthorID: "uo_alice", CreatedAt: 1700000000000, Status: "open"},
		{ID: "s_bob", AuthorID: "uo_bob", CreatedAt: 1700000010000, Status: "accepted",
			ResolvedBy: "uo_carol", ResolvedAt: 1700000020000, Note: "rewrite"},
	}
	spans := []suggestionSpan{
		{DocxRevisionID: 1, Kind: suggestionKindInsert, SuggestionID: "s_alice"},
		{DocxRevisionID: 2, Kind: suggestionKindDelete, SuggestionID: "s_bob"},
	}
	xmlBytes, err := writeSuggestionsCustomXML(spans, nil, nil, nil, original)
	if err != nil {
		t.Fatalf("write: %v", err)
	}

	parsedEntries, parsedMapping, err := parseSuggestionsCustomXML(xmlBytes)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(parsedEntries) != 2 {
		t.Errorf("expected 2 entries, got %d", len(parsedEntries))
	}
	// Find s_bob — has resolvedBy etc.
	var bob *SuggestionMapEntry
	for i := range parsedEntries {
		if parsedEntries[i].ID == "s_bob" {
			bob = &parsedEntries[i]
			break
		}
	}
	if bob == nil {
		t.Fatalf("missing s_bob in parsed entries")
	}
	if bob.Status != "accepted" {
		t.Errorf("status: %q", bob.Status)
	}
	if bob.ResolvedBy != "uo_carol" {
		t.Errorf("resolvedBy: %q", bob.ResolvedBy)
	}
	if bob.Note != "rewrite" {
		t.Errorf("note: %q", bob.Note)
	}
	// Per-kind mappings: insert vs delete keyed separately.
	if parsedMapping.Insert[1] != "s_alice" {
		t.Errorf("expected Insert[1] → s_alice, got %q", parsedMapping.Insert[1])
	}
	if parsedMapping.Delete[2] != "s_bob" {
		t.Errorf("expected Delete[2] → s_bob, got %q", parsedMapping.Delete[2])
	}
}
