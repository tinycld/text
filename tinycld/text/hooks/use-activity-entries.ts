import type { Editor } from '@tiptap/react'
import { useMemo } from 'react'
import type * as Y from 'yjs'
import { SuggestionsMap } from '../lib/suggestions/suggestions-map'
import {
    type EditEvent,
    SUGGESTION_STATUS_ACCEPTED,
    SUGGESTION_STATUS_REJECTED,
    type Suggestion,
} from '../webview-editor/source/suggestions/suggestion-types'
import { useDocumentSuggestionBridge } from './use-suggestion-bridge'
import { useEditEvents } from './use-edit-events'

// ActivityEntry is the tagged union the drawer's activity tab renders.
// `ts` is the timestamp the entry sorts on: endedAt for edit events,
// resolvedAt for resolved suggestions. Both are stored on the entry so
// the merge can sort once without re-deriving the timestamp per row.
export type ActivityEntry =
    | { kind: 'edit-event'; event: EditEvent; ts: number }
    | { kind: 'suggestion-resolved'; suggestion: Suggestion; ts: number }

// useActivityEntries merges the doc's editEvents Y.Array and any
// resolved suggestion entries from the suggestions Y.Map into one
// reverse-chronological list. The activity tab in the review drawer
// renders the result.
//
// Why both sources together: the user thinks of "activity on this doc"
// as a single timeline regardless of whether a row represents free
// typing (edit event) or a deliberate review action (resolved
// suggestion). Sorting both by their respective "completion" timestamp
// (endedAt / resolvedAt) reflects when the user actually finished the
// action, which is what surfaces meaningfully in the UI.
//
// Why look up the full Suggestion records via SuggestionsMap rather
// than the bridge's anchored/orphaned rows: those rows expose `ts`
// (creation time) and `status` but not `resolvedAt`. For resolved
// entries we need the resolution timestamp specifically — that's what
// places the row chronologically among the edit events. The bridge
// already observes the same Y.Map, so reading it again here doesn't
// double the work: SuggestionsMap.get is a constant-time Y.Map lookup
// and runs only for ids the bridge already flagged as resolved.
export function useActivityEntries(
    yDoc: Y.Doc | null,
    editor: Editor | null,
    driveItemId: string
): ActivityEntry[] {
    const events = useEditEvents(yDoc)
    const bridge = useDocumentSuggestionBridge({ driveItemId, yDoc, editor })
    const snapshot = bridge?.getSnapshot()
    const suggestionsMap = useMemo(() => (yDoc ? new SuggestionsMap(yDoc) : null), [yDoc])

    const entries: ActivityEntry[] = []
    for (const event of events) {
        entries.push({ kind: 'edit-event', event, ts: event.endedAt })
    }
    if (snapshot && suggestionsMap) {
        const seen = new Set<string>()
        const candidates = [...snapshot.anchored, ...snapshot.orphaned]
        for (const entry of candidates) {
            if (
                entry.status !== SUGGESTION_STATUS_ACCEPTED &&
                entry.status !== SUGGESTION_STATUS_REJECTED
            ) {
                continue
            }
            // Anchored + orphaned can theoretically overlap if a future
            // change reports the same id in both buckets; dedup defensively.
            if (seen.has(entry.id)) continue
            seen.add(entry.id)
            const full = suggestionsMap.get(entry.id)
            if (!full || full.resolvedAt === undefined) continue
            entries.push({
                kind: 'suggestion-resolved',
                suggestion: full,
                ts: full.resolvedAt,
            })
        }
    }
    entries.sort((a, b) => b.ts - a.ts)
    return entries
}
