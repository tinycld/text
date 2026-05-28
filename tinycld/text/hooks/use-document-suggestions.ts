import type { Node as PMNode } from '@tiptap/pm/model'
import type { Editor } from '@tiptap/react'
import { useEffect, useState } from 'react'
import type * as Y from 'yjs'
import { SuggestionsMap } from '../lib/suggestions/suggestions-map'
import {
    SUGGESTION_STATUS_OPEN,
    type SuggestionStatus,
} from '../webview-editor/source/suggestions/suggestion-types'

export const SNIPPET_MAX_LENGTH = 100

export type SuggestionKind = 'insert' | 'delete'

export interface AnchoredSuggestion {
    id: string
    status: SuggestionStatus
    authorId: string
    ts: number
    kind: SuggestionKind
    anchorRange: { from: number; to: number }
    snippet: string
}

export interface OrphanedSuggestion {
    id: string
    status: SuggestionStatus
    authorId: string
    ts: number
}

export interface DocumentSuggestionsResult {
    anchored: AnchoredSuggestion[]
    orphaned: OrphanedSuggestion[]
}

// computeDocumentSuggestions walks the editor doc and the suggestions
// Y.Map together. For each mark instance in the doc, emits one
// AnchoredSuggestion row carrying:
//   - the suggestionId (from the mark attrs)
//   - the kind ('insert' or 'delete', from the mark type)
//   - the doc range the mark covers (first occurrence wins for marks
//     that span multiple text nodes)
//   - a snippet of the marked text (capped at SNIPPET_MAX_LENGTH with
//     '…' suffix if truncated)
//
// Layered marks (Case 2b/2c — multiple marks on the same range)
// produce one row per (suggestionId, kind) combination.
//
// Any Y.Map entries whose suggestionId doesn't appear in any mark on
// the doc are reported as orphaned (e.g. another peer's edit removed
// the marked text but the map entry is still 'open'). The drawer
// shows them in a separate section so the user can still resolve them
// administratively.
//
// Pure function so tests can drive it directly. The hook wraps it
// with subscriptions to the editor + Y.Map.
export function computeDocumentSuggestions(
    doc: PMNode,
    map: SuggestionsMap
): DocumentSuggestionsResult {
    // First pass: walk the doc, record the first range we see for
    // each (suggestionId, kind) combination. Order is document order
    // because PM walks top-to-bottom.
    interface DocRange {
        id: string
        kind: SuggestionKind
        authorId: string
        ts: number
        from: number
        to: number
        snippet: string
    }
    const seenInDoc = new Map<string, DocRange>()

    doc.descendants((node, pos) => {
        if (!node.isText) return
        for (const mark of node.marks) {
            const kind: SuggestionKind | null =
                mark.type.name === 'suggestedInsert'
                    ? 'insert'
                    : mark.type.name === 'suggestedDelete'
                      ? 'delete'
                      : null
            if (!kind) continue
            const id = mark.attrs.suggestionId as string
            const key = `${id}::${kind}`
            const existing = seenInDoc.get(key)
            if (existing) {
                // Extend the range to include subsequent text nodes
                // bearing the same suggestionId, and grow the snippet
                // until we hit SNIPPET_MAX_LENGTH.
                existing.to = pos + node.nodeSize
                if (existing.snippet.length < SNIPPET_MAX_LENGTH) {
                    const remaining = SNIPPET_MAX_LENGTH - existing.snippet.length
                    const append = (node.text ?? '').slice(0, remaining)
                    existing.snippet += append
                }
            } else {
                const rawText = node.text ?? ''
                seenInDoc.set(key, {
                    id,
                    kind,
                    authorId: mark.attrs.authorId as string,
                    ts: mark.attrs.ts as number,
                    from: pos,
                    to: pos + node.nodeSize,
                    snippet: rawText.slice(0, SNIPPET_MAX_LENGTH),
                })
            }
        }
    })

    const anchored: AnchoredSuggestion[] = []
    for (const row of seenInDoc.values()) {
        const entry = map.get(row.id)
        const status = entry?.status ?? SUGGESTION_STATUS_OPEN
        // Truncation suffix when the snippet reached the cap.
        const snippet = row.snippet.length >= SNIPPET_MAX_LENGTH ? `${row.snippet}…` : row.snippet
        anchored.push({
            id: row.id,
            status,
            authorId: row.authorId,
            ts: row.ts,
            kind: row.kind,
            anchorRange: { from: row.from, to: row.to },
            snippet,
        })
    }
    // Document order: sort by the anchor's from position.
    anchored.sort((a, b) => a.anchorRange.from - b.anchorRange.from)

    // Orphan pass: any map entry whose id isn't keyed in seenInDoc.
    const seenIds = new Set(Array.from(seenInDoc.values()).map(r => r.id))
    const orphaned: OrphanedSuggestion[] = []
    for (const entry of map.list()) {
        if (seenIds.has(entry.id)) continue
        orphaned.push({
            id: entry.id,
            status: entry.status,
            authorId: entry.authorId,
            ts: entry.createdAt,
        })
    }

    return { anchored, orphaned }
}

// useDocumentSuggestions subscribes to both the editor's transactions
// and the suggestions Y.Map, recomputing on either change. Returns
// empty lists until the editor + yDoc are ready.
export function useDocumentSuggestions(
    editor: Editor | null,
    yDoc: Y.Doc | null
): DocumentSuggestionsResult {
    const [result, setResult] = useState<DocumentSuggestionsResult>({
        anchored: [],
        orphaned: [],
    })

    useEffect(() => {
        if (!editor || !yDoc) {
            setResult({ anchored: [], orphaned: [] })
            return
        }
        const map = new SuggestionsMap(yDoc)
        const recompute = () => setResult(computeDocumentSuggestions(editor.state.doc, map))

        // Initial population.
        recompute()

        // Recompute when the editor's doc changes.
        const onTr = () => recompute()
        editor.on('transaction', onTr)

        // Recompute when the Y.Map changes (other peers).
        const unobserve = map.observe(recompute)

        return () => {
            editor.off('transaction', onTr)
            unobserve()
        }
    }, [editor, yDoc])

    return result
}
