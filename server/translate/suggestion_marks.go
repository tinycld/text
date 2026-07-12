package translate

import (
	"time"
)

// suggestionKind discriminates the two flavors of suggestion mark. They share
// the queueing machinery but map to different docx revisions: insert -> w:ins,
// delete -> w:del (the writer swaps w:t for w:delText inside a delete).
type suggestionKind int

const (
	suggestionKindInsert suggestionKind = iota
	suggestionKindDelete
)

// suggestionSpan tracks one PM suggestion mark instance through the builder so
// the customXml part records the (w:id -> suggestionId) mapping. Layered marks
// produce multiple entries with distinct SuggestionID.
type suggestionSpan struct {
	// DocxRevisionID is the w:id written into <w:ins>/<w:del>; the customXml
	// mapping is keyed by it.
	DocxRevisionID int
	Kind           suggestionKind
	SuggestionID   string
	AuthorID       string
	// Ts is the unix-ms timestamp from the PM mark attrs; ISO-8601 for w:date.
	Ts int64
}

// queueSuggestionMarks emits one suggestionSpan per suggestedInsert /
// suggestedDelete mark, stamping a fresh DocxRevisionID and accumulating spans
// for later customXml serialization.
func (b *builder) queueSuggestionMarks(marks []PMMark) []suggestionSpan {
	if len(marks) == 0 {
		return nil
	}
	var spans []suggestionSpan
	for _, m := range marks {
		var kind suggestionKind
		switch m.Type {
		case MarkTypeSuggestedInsert:
			kind = suggestionKindInsert
		case MarkTypeSuggestedDelete:
			kind = suggestionKindDelete
		default:
			continue
		}
		suggestionID, _ := m.Attrs["suggestionId"].(string)
		authorID, _ := m.Attrs["authorId"].(string)
		var ts int64
		switch v := m.Attrs["ts"].(type) {
		case float64:
			ts = int64(v)
		case int:
			ts = int64(v)
		case int64:
			ts = v
		}
		b.insertDeleteSeq++
		span := suggestionSpan{
			DocxRevisionID: b.insertDeleteSeq,
			Kind:           kind,
			SuggestionID:   suggestionID,
			AuthorID:       authorID,
			Ts:             ts,
		}
		b.suggestionSpans = append(b.suggestionSpans, span)
		spans = append(spans, span)
	}
	return spans
}

// unixMsToISO8601 formats a unix-millisecond timestamp as an ISO-8601 / RFC
// 3339 string in UTC — the format docx's w:date attribute expects. Returns ""
// for ts==0 so the caller omits the attribute when there's no timestamp.
func unixMsToISO8601(ms int64) string {
	if ms == 0 {
		return ""
	}
	return time.UnixMilli(ms).UTC().Format(time.RFC3339)
}
