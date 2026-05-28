package translate

import (
	"bytes"
	"encoding/xml"
)

// SuggestionMapEntry represents one suggestion's metadata as held in
// the Yjs `suggestions` map (the runtime calls these "entries").
// Subset of what the client's TS Suggestion type carries — server
// only needs what we'll round-trip through docx.
type SuggestionMapEntry struct {
	ID         string
	AuthorID   string
	CreatedAt  int64  // unix ms
	Status     string // open | accepted | rejected
	ResolvedBy string // empty when status==open
	ResolvedAt int64  // 0 when status==open
	Note       string // optional user-attached note
}

// suggestionsXMLRoot is the top-level element shape we serialize.
// Namespace tinycld-suggestions/v1 — Word ignores anything in an
// unknown namespace, so this part is invisible to non-tinycld
// consumers.
type suggestionsXMLRoot struct {
	XMLName  xml.Name               `xml:"http://tinycld.org/suggestions/v1 tinycld-suggestions"`
	Mappings []suggestionMappingXML `xml:"mapping"`
	Entries  []suggestionEntryXML   `xml:"entry"`
}

type suggestionMappingXML struct {
	RevisionID   int    `xml:"revisionId,attr"`
	SuggestionID string `xml:"suggestionId,attr"`
	Kind         string `xml:"kind,attr"` // "insert" or "delete"
}

type suggestionEntryXML struct {
	ID         string `xml:"id,attr"`
	AuthorID   string `xml:"authorId,attr"`
	CreatedAt  int64  `xml:"createdAt,attr"`
	Status     string `xml:"status,attr"`
	ResolvedBy string `xml:"resolvedBy,attr,omitempty"`
	ResolvedAt int64  `xml:"resolvedAt,attr,omitempty"`
	Note       string `xml:"note,attr,omitempty"`
}

// writeSuggestionsCustomXML serializes the spans (for the
// w:id → suggestionId mapping) and the entries (for the metadata)
// into a custom XML part body. The caller is responsible for placing
// the bytes inside the docx zip at customXml/tinycld-suggestions.xml.
func writeSuggestionsCustomXML(
	spans []suggestionSpan,
	entries []SuggestionMapEntry,
) ([]byte, error) {
	root := suggestionsXMLRoot{}
	for _, s := range spans {
		kind := "insert"
		if s.Kind == suggestionKindDelete {
			kind = "delete"
		}
		root.Mappings = append(root.Mappings, suggestionMappingXML{
			RevisionID:   s.DocxRevisionID,
			SuggestionID: s.SuggestionID,
			Kind:         kind,
		})
	}
	for _, e := range entries {
		root.Entries = append(root.Entries, suggestionEntryXML{
			ID:         e.ID,
			AuthorID:   e.AuthorID,
			CreatedAt:  e.CreatedAt,
			Status:     e.Status,
			ResolvedBy: e.ResolvedBy,
			ResolvedAt: e.ResolvedAt,
			Note:       e.Note,
		})
	}
	var buf bytes.Buffer
	buf.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` + "\n")
	enc := xml.NewEncoder(&buf)
	enc.Indent("", "  ")
	if err := enc.Encode(root); err != nil {
		return nil, err
	}
	if err := enc.Flush(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// parseSuggestionsCustomXML is the inverse. Reads the part body and
// returns the entries (for re-populating the suggestions Y.Map) and
// the (revisionId → suggestionId) mapping (for re-stamping the marks
// with our richer ids during the docx → PM walk).
func parseSuggestionsCustomXML(data []byte) ([]SuggestionMapEntry, map[int]string, error) {
	if len(data) == 0 {
		return nil, nil, nil
	}
	var root suggestionsXMLRoot
	if err := xml.Unmarshal(data, &root); err != nil {
		return nil, nil, err
	}
	entries := make([]SuggestionMapEntry, 0, len(root.Entries))
	for _, e := range root.Entries {
		entries = append(entries, SuggestionMapEntry{
			ID:         e.ID,
			AuthorID:   e.AuthorID,
			CreatedAt:  e.CreatedAt,
			Status:     e.Status,
			ResolvedBy: e.ResolvedBy,
			ResolvedAt: e.ResolvedAt,
			Note:       e.Note,
		})
	}
	mapping := make(map[int]string, len(root.Mappings))
	for _, m := range root.Mappings {
		mapping[m.RevisionID] = m.SuggestionID
	}
	return entries, mapping, nil
}
