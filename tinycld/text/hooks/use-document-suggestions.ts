import type { Node as PMNode } from '@tiptap/pm/model'
import type { Editor } from '@tiptap/react'
import { useEffect, useState } from 'react'
import type * as Y from 'yjs'
import { SuggestionsMap } from '../lib/suggestions/suggestions-map'
import type {
    BlockChangeAfter,
    BlockChangeBefore,
    SerializedMarks,
} from '../webview-editor/source/suggestions/suggestion-types'
import {
    SUGGESTION_STATUS_OPEN,
    type SuggestionStatus,
} from '../webview-editor/source/suggestions/suggestion-types'

export const SNIPPET_MAX_LENGTH = 100

// Phase 5 adds three new suggestion kinds beyond the original insert/
// delete pair. format-change covers suggestedFormatChange marks
// (inline mark proposing a bold/italic/color/etc. delta on existing
// text). block-change covers suggestedBlockChange attributes on
// paragraph/heading/listItem/blockquote nodes (structural changes to
// a block). cell-change covers the same suggestedBlockChange attribute
// but on tableCell/tableHeader nodes — split out from block-change so
// the drawer/popover can render cell-specific copy ("add cell" vs
// "change to heading 2").
export type SuggestionKind = 'insert' | 'delete' | 'format-change' | 'block-change' | 'cell-change'

export interface AnchoredSuggestion {
    id: string
    status: SuggestionStatus
    authorId: string
    ts: number
    kind: SuggestionKind
    anchorRange: { from: number; to: number }
    snippet: string
    // Phase 5 additions, optional and only set for matching kinds.
    // The format-change kind carries the before/after mark sets so the
    // drawer/popover can summarize the proposed delta ("add bold").
    beforeMarks?: SerializedMarks
    afterMarks?: SerializedMarks
    // The block-change and cell-change kinds carry the before/after
    // block payloads so the drawer/popover can summarize the proposed
    // structural delta ("change to heading 2", "delete paragraph",
    // "add cell").
    beforeBlock?: BlockChangeBefore
    afterBlock?: BlockChangeAfter
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
// Y.Map together. Emits one AnchoredSuggestion row per (suggestionId,
// kind) pair observed in the doc:
//   - suggestedInsert / suggestedDelete marks on text → kind='insert' / 'delete'
//   - suggestedFormatChange marks on text → kind='format-change'
//   - suggestedBlockChange attribute on a block-level node →
//     kind='block-change' (paragraph/heading/listItem/blockquote) or
//     kind='cell-change' (tableCell/tableHeader)
//
// Each row carries:
//   - the suggestionId
//   - the doc range the mark/attribute covers (first occurrence wins
//     for entries that span multiple nodes; subsequent occurrences
//     extend the range and snippet)
//   - a snippet (capped at SNIPPET_MAX_LENGTH with '…' suffix if
//     truncated): the marked text for inline marks, the block's
//     textContent for block-changes, the literal "Cell" for cell-
//     changes (which can be empty when proposing a fresh cell add).
//   - for format-change, the before/after mark sets (beforeMarks/
//     afterMarks) so the drawer/popover can render a delta summary
//     without reaching back into the doc.
//   - for block-change / cell-change, the before/after block payloads
//     (beforeBlock/afterBlock) so the drawer/popover can render the
//     proposed structural delta.
//
// Layered marks (Case 2b/2c — multiple marks on the same range)
// produce one row per (suggestionId, kind) combination. Multiple
// suggestedFormatChange marks with the same id stack additively
// (Case 2c's excludes: '' allows the same id across consecutive
// toggleBold + toggleItalic calls); for parity with insert/delete
// the parser consolidates them into ONE row per (id, kind) — the
// last-seen mark's before/after attrs win, which mirrors how
// resolve.ts replays all matching marks back-to-back.
//
// Any Y.Map entries whose suggestionId doesn't appear in any mark/
// attribute on the doc are reported as orphaned (e.g. another peer's
// edit removed the marked text but the map entry is still 'open').
// The drawer shows them in a separate section so the user can still
// resolve them administratively.
//
// DocRange is the per-suggestion accumulator the doc walk fills in.
// Lives at module scope so the helper functions (recordBlockChange,
// recordMarkChange) can take it by name.
interface DocRange {
    id: string
    kind: SuggestionKind
    authorId: string
    ts: number
    from: number
    to: number
    snippet: string
    beforeMarks?: SerializedMarks
    afterMarks?: SerializedMarks
    beforeBlock?: BlockChangeBefore
    afterBlock?: BlockChangeAfter
}

// recordBlockChange handles the suggestedBlockChange attribute branch
// of the doc walk. Skips silently when the attr is missing or wrongly
// shaped; otherwise updates / inserts the matching DocRange entry.
function recordBlockChange(node: PMNode, pos: number, seenInDoc: Map<string, DocRange>): void {
    const blockChange = node.attrs.suggestedBlockChange as unknown
    if (!blockChange || typeof blockChange !== 'object') return
    const payload = blockChange as {
        suggestionId?: unknown
        authorId?: unknown
        ts?: unknown
        before?: unknown
        after?: unknown
    }
    if (
        typeof payload.suggestionId !== 'string' ||
        typeof payload.authorId !== 'string' ||
        !payload.before ||
        typeof payload.before !== 'object' ||
        !payload.after ||
        typeof payload.after !== 'object'
    ) {
        return
    }
    const isCell = node.type.name === 'tableCell' || node.type.name === 'tableHeader'
    const kind: SuggestionKind = isCell ? 'cell-change' : 'block-change'
    const id = payload.suggestionId
    const key = `${id}::${kind}`
    const before = payload.before as BlockChangeBefore
    const after = payload.after as BlockChangeAfter
    // Snippet: text content for non-cell block changes (capped at
    // SNIPPET_MAX_LENGTH); literal "Cell" for cell-changes (a cell
    // can be empty when proposing a fresh addRow/addColumn cell, so
    // its textContent is unreliable as a visual cue).
    const rawSnippet = isCell ? 'Cell' : (node.textContent ?? '')
    const existing = seenInDoc.get(key)
    if (existing) {
        existing.to = pos + node.nodeSize
        if (existing.snippet.length < SNIPPET_MAX_LENGTH) {
            const remaining = SNIPPET_MAX_LENGTH - existing.snippet.length
            existing.snippet += rawSnippet.slice(0, remaining)
        }
        // Re-anchor before/after to the latest seen payload (matches
        // the "last wins" behavior of the format-change branch below).
        existing.beforeBlock = before
        existing.afterBlock = after
        return
    }
    seenInDoc.set(key, {
        id,
        kind,
        authorId: payload.authorId,
        ts: typeof payload.ts === 'number' ? payload.ts : 0,
        from: pos,
        to: pos + node.nodeSize,
        snippet: rawSnippet.slice(0, SNIPPET_MAX_LENGTH),
        beforeBlock: before,
        afterBlock: after,
    })
}

// recordMarkChange handles one inline mark on a text node. Skips
// silently when the mark isn't a recognised suggestion kind; otherwise
// updates / inserts the matching DocRange entry. format-change marks
// also stash before/after mark sets on the entry.
function recordMarkChange(
    node: PMNode,
    pos: number,
    mark: PMNode['marks'][number],
    seenInDoc: Map<string, DocRange>
): void {
    const markName = mark.type.name
    const kind: SuggestionKind | null =
        markName === 'suggestedInsert'
            ? 'insert'
            : markName === 'suggestedDelete'
              ? 'delete'
              : markName === 'suggestedFormatChange'
                ? 'format-change'
                : null
    if (!kind) return
    const id = mark.attrs.suggestionId as string
    const key = `${id}::${kind}`
    const existing = seenInDoc.get(key)
    if (existing) {
        existing.to = pos + node.nodeSize
        if (existing.snippet.length < SNIPPET_MAX_LENGTH) {
            const remaining = SNIPPET_MAX_LENGTH - existing.snippet.length
            const append = (node.text ?? '').slice(0, remaining)
            existing.snippet += append
        }
        // format-change: stacked marks with the same id (Case 2c's
        // excludes: '') each carry their own before/after. The
        // last-seen mark's before/after wins — the resolve path
        // iterates all matching marks anyway, so the summary just
        // needs to identify the proposal scope.
        if (kind === 'format-change') {
            existing.beforeMarks = Array.isArray(mark.attrs.before)
                ? (mark.attrs.before as SerializedMarks)
                : []
            existing.afterMarks = Array.isArray(mark.attrs.after)
                ? (mark.attrs.after as SerializedMarks)
                : []
        }
        return
    }
    const rawText = node.text ?? ''
    const entry: DocRange = {
        id,
        kind,
        authorId: mark.attrs.authorId as string,
        ts: mark.attrs.ts as number,
        from: pos,
        to: pos + node.nodeSize,
        snippet: rawText.slice(0, SNIPPET_MAX_LENGTH),
    }
    if (kind === 'format-change') {
        entry.beforeMarks = Array.isArray(mark.attrs.before)
            ? (mark.attrs.before as SerializedMarks)
            : []
        entry.afterMarks = Array.isArray(mark.attrs.after)
            ? (mark.attrs.after as SerializedMarks)
            : []
    }
    seenInDoc.set(key, entry)
}

// Pure function so tests can drive it directly. The hook wraps it
// with subscriptions to the editor + Y.Map.
export function computeDocumentSuggestions(
    doc: PMNode,
    map: SuggestionsMap
): DocumentSuggestionsResult {
    const seenInDoc = new Map<string, DocRange>()

    doc.descendants((node, pos) => {
        // Block-level branch — check suggestedBlockChange BEFORE
        // recursing into the node's text content. The attribute lives
        // on the block node, not on its inline children, so the
        // text-only branch below would miss it. We still descend (no
        // early return) so a block-change that also wraps text with
        // suggestedInsert/Delete from a different id surfaces both.
        recordBlockChange(node, pos, seenInDoc)
        if (!node.isText) return
        for (const mark of node.marks) {
            recordMarkChange(node, pos, mark, seenInDoc)
        }
    })

    const anchored: AnchoredSuggestion[] = []
    for (const row of seenInDoc.values()) {
        const entry = map.get(row.id)
        const status = entry?.status ?? SUGGESTION_STATUS_OPEN
        // Truncation suffix when the snippet reached the cap.
        const snippet = row.snippet.length >= SNIPPET_MAX_LENGTH ? `${row.snippet}…` : row.snippet
        const out: AnchoredSuggestion = {
            id: row.id,
            status,
            authorId: row.authorId,
            ts: row.ts,
            kind: row.kind,
            anchorRange: { from: row.from, to: row.to },
            snippet,
        }
        if (row.beforeMarks) out.beforeMarks = row.beforeMarks
        if (row.afterMarks) out.afterMarks = row.afterMarks
        if (row.beforeBlock) out.beforeBlock = row.beforeBlock
        if (row.afterBlock) out.afterBlock = row.afterBlock
        anchored.push(out)
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
