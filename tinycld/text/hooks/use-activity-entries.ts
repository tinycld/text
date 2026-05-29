import type * as Y from 'yjs'
import type { EditEvent } from '../webview-editor/source/suggestions/suggestion-types'
import { useEditEvents } from './use-edit-events'

// ActivityEntry is the row shape the drawer's activity tab renders.
// `ts` is the timestamp the entry sorts on: endedAt for edit events.
//
// Phase 3b briefly merged resolved-suggestion entries into this stream
// alongside edit events. That path is gone: resolved entries are auto-
// deleted from the suggestions Y.Map by useDocumentSuggestions (any
// map row with no doc anchor — including ones whose marks were
// stripped by Accept / Reject — is considered orphaned and dropped),
// so there's no resolved row to read back. The broker-emitted
// editEvents are now the single source of truth for the activity feed.
//
// The tagged-union shape with a discriminated `kind` field is kept
// (rather than just returning EditEvent[]) so a future enhancement
// that wants to mix in another kind of activity entry doesn't have to
// thread a breaking type change through the renderer.
export type ActivityEntry = { kind: 'edit-event'; event: EditEvent; ts: number }

export function useActivityEntries(yDoc: Y.Doc | null): ActivityEntry[] {
    const events = useEditEvents(yDoc)
    const entries: ActivityEntry[] = events.map(event => ({
        kind: 'edit-event',
        event,
        ts: event.endedAt,
    }))
    entries.sort((a, b) => b.ts - a.ts)
    return entries
}
