package text

import (
	"strconv"

	ycrdt "github.com/skyterra/y-crdt"
)

// authorshipEntry is one row to stamp into the Y.Doc protected roots.
// ClientID is the Yjs uint32 clientID extracted from the inbound update.
// UserOrgID is the PB user_org.id resolved from the connection.
// FirstSeenMS is the broker's wallclock at the moment of stamping.
type authorshipEntry struct {
	ClientID    uint32
	UserOrgID   string
	FirstSeenMS int64
}

// writeAuthorshipEntries mutates the server-side Y.Doc by writing each
// entry's (clientID → userOrgID) into the clientAuthors root and
// (clientID → firstSeenMS) into the clientFirstSeen root, then returns
// the bytes of a Yjs update covering only those mutations — ready to
// hand to Room.PublishDocUpdate for broadcast + journal.
//
// Empty entries returns nil bytes and no error — the caller skips the
// broadcast in that case.
//
// Stringified keys: YMap keys are strings; we format the uint32
// clientID as decimal. Phase 3b/3c TS consumers do the inverse
// (Number(key)) to read it back.
func writeAuthorshipEntries(doc *ycrdt.Doc, entries []authorshipEntry) ([]byte, error) {
	if len(entries) == 0 {
		return nil, nil
	}
	beforeSV := ycrdt.EncodeStateVector(doc, nil, ycrdt.NewUpdateEncoderV1())

	authors, _ := doc.GetMap("clientAuthors").(*ycrdt.YMap)
	firstSeen, _ := doc.GetMap("clientFirstSeen").(*ycrdt.YMap)
	if authors == nil || firstSeen == nil {
		// Should never happen — GetMap on a freshly-created root returns
		// a usable handle. Bail safely.
		return nil, nil
	}
	for _, e := range entries {
		k := strconv.FormatUint(uint64(e.ClientID), 10)
		authors.Set(k, e.UserOrgID)
		// y-crdt's TypeMapSet only accepts the library's Number alias
		// (`type Number = int`) for integer content; int64 falls through
		// the type switch and is silently rejected. Store as int — the
		// underlying VarInt encoding handles the full int64 range on
		// 64-bit platforms, which is the only target this server runs on.
		firstSeen.Set(k, int(e.FirstSeenMS))
	}
	delta := ycrdt.EncodeStateAsUpdate(doc, beforeSV)
	return delta, nil
}
