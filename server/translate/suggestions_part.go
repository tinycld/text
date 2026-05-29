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

// suggestionMappings collects the (w:id → suggestionId) mappings
// recovered from the customXml part. Each docx revision kind has its
// OWN w:id sequence (Word allocates them independently), so the parser
// keeps a separate map per kind. Phase 2c shipped with Insert/Delete
// only; Phase 5 adds FormatChange (Task 18) and BlockChange (Task 19).
type suggestionMappings struct {
	// Insert maps the w:id from a <w:ins ...> element to the suggestionId.
	Insert map[int]string
	// Delete maps the w:id from a <w:del ...> element to the suggestionId.
	Delete map[int]string
	// FormatChange maps the w:id from a <w:rPrChange ...> element to
	// the suggestionId.
	FormatChange map[int]string
	// BlockChange maps the w:id from a <w:pPrChange ...> element to
	// the suggestionId. Unlike Insert/Delete (which the legacy
	// fallback also populates for backwards-compat), BlockChange only
	// gets populated by the modern kind="blockChange" entries — a
	// Word-authored docx that only carries Word's own <w:pPrChange>
	// elements (no tinycld customXml) synthesizes ids at parse time.
	BlockChange map[int]string
}

// writeSuggestionsCustomXML serializes the spans (for the
// w:id → suggestionId mapping) and the entries (for the metadata)
// into a custom XML part body. The caller is responsible for placing
// the bytes inside the docx zip at customXml/tinycld-suggestions.xml.
func writeSuggestionsCustomXML(
	spans []suggestionSpan,
	formatChangeSpans []formatChangeSpan,
	blockChangeSpans []blockChangeSpan,
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
	for _, s := range formatChangeSpans {
		root.Mappings = append(root.Mappings, suggestionMappingXML{
			RevisionID:   s.DocxRevisionID,
			SuggestionID: s.SuggestionID,
			Kind:         "formatChange",
		})
	}
	for _, s := range blockChangeSpans {
		root.Mappings = append(root.Mappings, suggestionMappingXML{
			RevisionID:   s.DocxRevisionID,
			SuggestionID: s.SuggestionID,
			Kind:         "blockChange",
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
// the per-kind (revisionId → suggestionId) mappings (for re-stamping
// the marks with our richer ids during the docx → PM walk).
//
// The returned suggestionMappings keep separate insert/delete/formatChange
// maps because each docx revision kind has its own w:id sequence; a
// pre-Phase-5 file that only carries "insert"/"delete" mappings parses
// with FormatChange empty. Unknown / legacy kinds (older files that
// omitted Kind=…) are written into BOTH Insert and Delete so callers
// looking up either kind still resolve them — the union-fallback flow
// from the original Phase 2c shape.
func parseSuggestionsCustomXML(data []byte) ([]SuggestionMapEntry, suggestionMappings, error) {
	if len(data) == 0 {
		return nil, suggestionMappings{}, nil
	}
	var root suggestionsXMLRoot
	if err := xml.Unmarshal(data, &root); err != nil {
		return nil, suggestionMappings{}, err
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
	maps := suggestionMappings{
		Insert:       map[int]string{},
		Delete:       map[int]string{},
		FormatChange: map[int]string{},
		BlockChange:  map[int]string{},
	}
	for _, m := range root.Mappings {
		switch m.Kind {
		case "insert":
			maps.Insert[m.RevisionID] = m.SuggestionID
		case "delete":
			maps.Delete[m.RevisionID] = m.SuggestionID
		case "formatChange":
			maps.FormatChange[m.RevisionID] = m.SuggestionID
		case "blockChange":
			maps.BlockChange[m.RevisionID] = m.SuggestionID
		default:
			// Backwards-compat: pre-Phase-5 emitter set Kind to
			// "insert" or "delete"; an empty / unknown kind landed in
			// the legacy single-map flow. Stash into BOTH insert and
			// delete maps so old docs keep parsing identically. Phase-5
			// FormatChange and BlockChange kinds are NOT in the legacy
			// fallback — only Insert/Delete have a pre-Phase-5 history.
			maps.Insert[m.RevisionID] = m.SuggestionID
			maps.Delete[m.RevisionID] = m.SuggestionID
		}
	}
	return entries, maps, nil
}
