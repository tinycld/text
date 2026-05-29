package text

import (
	"fmt"

	ycrdt "github.com/skyterra/y-crdt"
)

// MaxEditEventsRetained caps the editEvents Y.Array's length so the
// doc doesn't grow unbounded. Per spec: keep the most recent 100.
const MaxEditEventsRetained = 100

// writeEditEvent appends an EditEvent to the doc's editEvents Y.Array,
// pruning oldest entries if the length would exceed
// MaxEditEventsRetained. Returns delta bytes ready for
// Room.PublishDocUpdate.
//
// y-crdt quirk parallels with authorship_writer: y-crdt's content type
// switch only accepts the library's Number alias (`type Number = int`)
// for integer content; int64 falls through silently and is dropped. We
// narrow ClientID/StartedAt/EndedAt to int before serialization so the
// TS consumer sees the expected `number` values.
//
// y-crdt API note: YArray.Push takes ArrayAny (= []any), not a single
// item — the slice-wrap idiom mirrors the existing test code's pattern.
// YArray.Length is a field on the embedded AbstractType, not a method.
// doc.GetArray returns *YArray directly (unlike GetMap, which returns
// IAbstractType); we check nil rather than type-asserting.
func writeEditEvent(doc *ycrdt.Doc, event EditEvent) ([]byte, error) {
	beforeSV := ycrdt.EncodeStateVector(doc, nil, ycrdt.NewUpdateEncoderV1())
	arr := doc.GetArray("editEvents")
	if arr == nil {
		return nil, fmt.Errorf("text: writeEditEvent: editEvents root missing (corrupt doc)")
	}

	// Prune oldest first so post-push length == MaxEditEventsRetained.
	// If length == 100, remove 1 → 99 + push = 100. If length == 105
	// (somehow), remove 6 → 99 + push = 100. Always bounded.
	if arr.Length >= MaxEditEventsRetained {
		toRemove := arr.Length - MaxEditEventsRetained + 1
		arr.Delete(0, toRemove)
	}

	entry := map[string]interface{}{
		"clientId":  int(event.ClientID),
		"authorId":  event.AuthorID,
		"startedAt": int(event.StartedAt),
		"endedAt":   int(event.EndedAt),
		"editCount": event.EditCount,
	}
	nodes := make([]interface{}, 0, len(event.AffectedNodes))
	for _, n := range event.AffectedNodes {
		nodes = append(nodes, map[string]interface{}{
			"nodeId":  n.NodeID,
			"snippet": n.Snippet,
		})
	}
	entry["affectedNodes"] = nodes
	arr.Push([]any{entry})

	return ycrdt.EncodeStateAsUpdate(doc, beforeSV), nil
}
