package translate

import (
	"strconv"
	"time"
)

// suggestionKind discriminates the two flavors of suggestion mark we
// emit. They share most of the queueing/serialization machinery, but
// differ in whether they wrap with <w:ins> (insert) or <w:del>
// (delete), and whether the contained text becomes <w:t> or <w:delText>.
type suggestionKind int

const (
	suggestionKindInsert suggestionKind = iota
	suggestionKindDelete
)

// suggestionSpan tracks one PM suggestion mark instance through the
// emitter so the post-process pass can write the customXml part. The
// shape mirrors commentSpan — one entry per (run, mark) pair the
// emitter encounters during the walk. Layered marks (Case 2c) produce
// multiple entries with the same range but distinct SuggestionID.
type suggestionSpan struct {
	// DocxRevisionID is the w:id we'll write into <w:ins>/<w:del>.
	// docx requires this be an unsigned integer; we mint a fresh one
	// per span. The customXml part maintains the (w:id → suggestionId)
	// mapping so we can recover our richer id on import.
	DocxRevisionID int
	Kind           suggestionKind
	SuggestionID   string
	AuthorID       string
	// Ts is the unix-ms timestamp from the PM mark attrs. The docx
	// w:date is ISO-8601 derived from this.
	Ts int64
	// OpenMarker / CloseMarker are the placeholder text tokens we
	// plant flanking the real run during WordZero emission. The post-
	// process pass (rewriteSuggestionRanges) finds them in the
	// serialized document.xml and rewrites them into <w:ins>/<w:del>
	// open/close wrappers around the surviving real runs.
	OpenMarker  string
	CloseMarker string
}

// suggestionOpenToken / suggestionCloseToken format the unique marker
// strings planted around suggestion-marked runs. Numbered by
// em.suggestionSpanSeq so each (run, mark) pair gets its own pair —
// the same pattern comment marks use (see commentOpenToken).
func suggestionOpenToken(n int) string {
	return "{{__pmsg:" + strconv.Itoa(n) + ":open}}"
}
func suggestionCloseToken(n int) string {
	return "{{__pmsg:" + strconv.Itoa(n) + ":close}}"
}

// queueSuggestionMarks walks the given marks slice and emits one
// suggestionSpan per suggestedInsert / suggestedDelete mark. Non-
// suggestion marks are ignored. The emitter stamps a fresh
// DocxRevisionID per span and stores it for later serialization.
//
// Idempotency is NOT a concern at this layer — the caller is expected
// to call queueSuggestionMarks once per run encounter. The emitter
// itself accumulates spans across the whole document walk.
func (em *emitter) queueSuggestionMarks(marks []PMMark) []suggestionSpan {
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
		em.suggestionSpanSeq++
		span := suggestionSpan{
			DocxRevisionID: em.suggestionSpanSeq,
			Kind:           kind,
			SuggestionID:   suggestionID,
			AuthorID:       authorID,
			Ts:             ts,
			OpenMarker:     suggestionOpenToken(em.suggestionSpanSeq),
			CloseMarker:    suggestionCloseToken(em.suggestionSpanSeq),
		}
		em.suggestionSpans = append(em.suggestionSpans, span)
		spans = append(spans, span)
	}
	return spans
}

// hasDeleteSpan reports whether any of the given spans is a delete.
// Used by emitTextRun to decide whether the inner text element gets
// emitted as <w:t> (the default) or <w:delText> (Word requires the
// latter for any text inside a <w:del> wrapper).
func hasDeleteSpan(spans []suggestionSpan) bool {
	for _, s := range spans {
		if s.Kind == suggestionKindDelete {
			return true
		}
	}
	return false
}

// unixMsToISO8601 formats a unix-millisecond timestamp as an
// ISO-8601 / RFC 3339 string in UTC — the format docx's w:date
// attribute expects on <w:ins>/<w:del>. Returns "" for ts==0 so the
// caller can omit the attribute when there's no real timestamp to
// record.
func unixMsToISO8601(ms int64) string {
	if ms == 0 {
		return ""
	}
	return time.UnixMilli(ms).UTC().Format(time.RFC3339)
}
