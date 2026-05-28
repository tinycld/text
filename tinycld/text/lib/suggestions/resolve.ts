import type { Editor } from '@tiptap/core'
import type * as Y from 'yjs'
import {
    SUGGESTION_STATUS_ACCEPTED,
    SUGGESTION_STATUS_REJECTED,
} from '../../webview-editor/source/suggestions/suggestion-types'
import { SuggestionsMap } from './suggestions-map'

export interface ResolveOptions {
    resolverUserOrgId: string
    yDoc: Y.Doc
}

interface Range {
    from: number
    to: number
}

// Collect ranges in the current doc carrying the given mark + suggestionId.
function collectRanges(editor: Editor, markName: string, suggestionId: string): Range[] {
    const ranges: Range[] = []
    editor.state.doc.descendants((node, pos) => {
        if (!node.isText) return
        const m = node.marks.find(
            m => m.type.name === markName && m.attrs.suggestionId === suggestionId
        )
        if (m) {
            ranges.push({ from: pos, to: pos + node.nodeSize })
        }
    })
    return ranges
}

// acceptSuggestion strips suggestedInsert marks (text becomes regular)
// and removes text bearing suggestedDelete with the target id (text gone).
// Then updates the suggestions Y.Map entry to ACCEPTED.
export function acceptSuggestion(
    editor: Editor,
    suggestionId: string,
    options: ResolveOptions
): void {
    const insertRanges = collectRanges(editor, 'suggestedInsert', suggestionId)
    const deleteRanges = collectRanges(editor, 'suggestedDelete', suggestionId)

    editor
        .chain()
        .command(({ tr, state }) => {
            const insertMarkType = state.schema.marks.suggestedInsert
            // Strip insert marks (back-to-front so positions stay stable).
            for (const r of [...insertRanges].reverse()) {
                tr.removeMark(r.from, r.to, insertMarkType)
            }
            // Remove delete-marked ranges (back-to-front, re-mapping
            // through any prior steps in this transaction).
            for (const r of [...deleteRanges].reverse()) {
                const from = tr.mapping.map(r.from)
                const to = tr.mapping.map(r.to)
                tr.delete(from, to)
            }
            return true
        })
        .run()

    const map = new SuggestionsMap(options.yDoc)
    map.resolve(suggestionId, {
        status: SUGGESTION_STATUS_ACCEPTED,
        by: options.resolverUserOrgId,
        at: Date.now(),
    })
}

// rejectSuggestion removes text bearing suggestedInsert with the target
// id (text gone) and strips suggestedDelete marks (text stays).
// Then updates the suggestions Y.Map entry to REJECTED.
export function rejectSuggestion(
    editor: Editor,
    suggestionId: string,
    options: ResolveOptions
): void {
    const insertRanges = collectRanges(editor, 'suggestedInsert', suggestionId)
    const deleteRanges = collectRanges(editor, 'suggestedDelete', suggestionId)

    editor
        .chain()
        .command(({ tr, state }) => {
            const deleteMarkType = state.schema.marks.suggestedDelete
            // Remove insert-marked ranges (back-to-front).
            for (const r of [...insertRanges].reverse()) {
                const from = tr.mapping.map(r.from)
                const to = tr.mapping.map(r.to)
                tr.delete(from, to)
            }
            // Strip delete marks (re-mapped through any prior deletes).
            for (const r of [...deleteRanges].reverse()) {
                const from = tr.mapping.map(r.from)
                const to = tr.mapping.map(r.to)
                tr.removeMark(from, to, deleteMarkType)
            }
            return true
        })
        .run()

    const map = new SuggestionsMap(options.yDoc)
    map.resolve(suggestionId, {
        status: SUGGESTION_STATUS_REJECTED,
        by: options.resolverUserOrgId,
        at: Date.now(),
    })
}
