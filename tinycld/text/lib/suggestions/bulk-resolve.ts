import type { Editor } from '@tiptap/react'
import type * as Y from 'yjs'
import { acceptSuggestion, rejectSuggestion } from './resolve'
import { SuggestionsMap } from './suggestions-map'

export interface BulkResolveOptions {
    resolverUserId: string
    yDoc: Y.Doc
}

// bulkAccept calls acceptSuggestion for each id in suggestionIds,
// wrapping the whole thing in yDoc.transact so peers see the entire
// batch as one Yjs transaction.
//
// Iteration order is the order of the input array — callers should
// pre-sort by document position so peers' undo history reads in a
// sensible order.
//
// Missing ids (not in the suggestions map) are silently skipped: a
// drawer that was rendered against a stale Y.Map snapshot shouldn't
// throw if the user fires Accept All while a peer is concurrently
// resolving items.
export function bulkAccept(
    editor: Editor,
    suggestionIds: string[],
    options: BulkResolveOptions
): void {
    if (suggestionIds.length === 0) return
    const map = new SuggestionsMap(options.yDoc)
    options.yDoc.transact(() => {
        for (const id of suggestionIds) {
            if (!map.get(id)) continue
            acceptSuggestion(editor, id, options)
        }
    })
}

// bulkReject is the symmetric reject path. Same atomicity guarantees.
export function bulkReject(
    editor: Editor,
    suggestionIds: string[],
    options: BulkResolveOptions
): void {
    if (suggestionIds.length === 0) return
    const map = new SuggestionsMap(options.yDoc)
    options.yDoc.transact(() => {
        for (const id of suggestionIds) {
            if (!map.get(id)) continue
            rejectSuggestion(editor, id, options)
        }
    })
}
