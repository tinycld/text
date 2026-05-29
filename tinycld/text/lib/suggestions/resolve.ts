import type { Editor } from '@tiptap/core'
import type { Mark } from '@tiptap/pm/model'
import type * as Y from 'yjs'
import type { SerializedMarks } from '../../webview-editor/source/suggestions/suggestion-types'
import {
    SUGGESTION_STATUS_ACCEPTED,
    SUGGESTION_STATUS_REJECTED,
} from '../../webview-editor/source/suggestions/suggestion-types'
import { deserializeMarks } from './serialize-marks'
import { SuggestionsMap } from './suggestions-map'

export interface ResolveOptions {
    resolverUserOrgId: string
    yDoc: Y.Doc
}

interface Range {
    from: number
    to: number
}

// FormatChangeRange carries the mark range plus the proposed before/
// after sets so accept can compute the mark delta. Accept must (a)
// remove marks present in `before` but absent in `after` and (b) add
// marks present in `after` but absent in `before`, because the visible
// doc state currently matches `before` (the command layer reverted
// the user's toggle when stamping the suggestion). Reject ignores
// both — the underlying marks already match before-state, so dropping
// the wrapper is enough.
interface FormatChangeRange extends Range {
    before: SerializedMarks
    after: SerializedMarks
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

// collectFormatChangeRanges walks the doc and returns every text-node
// range carrying a suggestedFormatChange mark with the target id, plus
// the proposed after-set deserialized from the mark's attrs.
//
// Because suggestedFormatChange uses `excludes: ''` (Case 2c stacking),
// a single text node can carry MULTIPLE wrapper marks for the same
// suggestionId — e.g. when one session emits toggleBold then
// toggleItalic over the same range, two marks with the same id stack
// (one carrying after=[bold], the other after=[italic]). Iterating
// every matching mark (not just the first) is required so accept
// replays the full proposed after-set across all the per-toggle
// stacked marks.
function collectFormatChangeRanges(editor: Editor, suggestionId: string): FormatChangeRange[] {
    const ranges: FormatChangeRange[] = []
    editor.state.doc.descendants((node, pos) => {
        if (!node.isText) return
        for (const m of node.marks) {
            if (m.type.name !== 'suggestedFormatChange') continue
            if (m.attrs.suggestionId !== suggestionId) continue
            const before = Array.isArray(m.attrs.before)
                ? (m.attrs.before as SerializedMarks)
                : []
            const after = Array.isArray(m.attrs.after) ? (m.attrs.after as SerializedMarks) : []
            ranges.push({ from: pos, to: pos + node.nodeSize, before, after })
        }
    })
    return ranges
}

// markKey deterministically hashes a serialized mark (type + attrs) so
// before/after sets can be diffed by membership. Attr key order is
// normalized to handle PM's mark attr round-trip.
function markKey(entry: { type: string; attrs?: Record<string, unknown> }): string {
    const attrs = entry.attrs ?? {}
    const keys = Object.keys(attrs).sort()
    const normalized = keys.map(k => [k, attrs[k]] as const)
    return `${entry.type}:${JSON.stringify(normalized)}`
}

// acceptSuggestion strips suggestedInsert marks (text becomes regular)
// and removes text bearing suggestedDelete with the target id (text gone).
// For suggestedFormatChange: strips the wrapper mark and applies each
// mark in the proposed after-set (with its attrs) over the same range,
// so a "propose bold" accept lands the actual bold mark on the run.
// Then updates the suggestions Y.Map entry to ACCEPTED.
//
// Both writes — the PM transaction (bridged into Yjs by y-prosemirror)
// and the SuggestionsMap status flip — run inside a single yDoc.transact
// so peers see them in one atomic update. Without this, a concurrent
// observer can land in a window where the marks are gone but
// suggestion.status is still 'open', or vice versa, producing a
// "phantom pending" entry in the suggestion list.
export function acceptSuggestion(
    editor: Editor,
    suggestionId: string,
    options: ResolveOptions
): void {
    const insertRanges = collectRanges(editor, 'suggestedInsert', suggestionId)
    const deleteRanges = collectRanges(editor, 'suggestedDelete', suggestionId)
    const formatChangeRanges = collectFormatChangeRanges(editor, suggestionId)

    options.yDoc.transact(() => {
        editor
            .chain()
            .command(({ tr, state }) => {
                const insertMarkType = state.schema.marks.suggestedInsert
                const formatChangeMarkType = state.schema.marks.suggestedFormatChange
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
                // Resolve format-change marks: strip the suggestion
                // wrapper, then apply the before→after delta on the
                // underlying range. The visible doc state currently
                // matches `before` (the command layer reverted the
                // user's toggle when stamping the suggestion), so the
                // delta is the minimum work needed to land the
                // proposed `after`-set on the run.
                //
                // Computing the delta (instead of "strip wrapper +
                // addMark for each entry in after") is required for
                // mark-removal proposals: a "remove bold" suggestion
                // has before=[bold], after=[]. Just adding after-marks
                // would leave bold in place. The delta path correctly
                // removes the bold mark.
                //
                // Back-to-front for positional safety so addMark/
                // removeMark on later ranges don't shift earlier
                // positions.
                for (const r of [...formatChangeRanges].reverse()) {
                    const from = tr.mapping.map(r.from)
                    const to = tr.mapping.map(r.to)
                    tr.removeMark(from, to, formatChangeMarkType)

                    const beforeKeys = new Set(r.before.map(markKey))
                    const afterKeys = new Set(r.after.map(markKey))
                    const toRemove = r.before.filter(e => !afterKeys.has(markKey(e)))
                    const toAdd = r.after.filter(e => !beforeKeys.has(markKey(e)))

                    // Remove marks present in before but not after.
                    // removeMark with a Mark instance strips that exact
                    // type+attrs combination.
                    const removeMarks: Mark[] = deserializeMarks(toRemove, state.schema)
                    for (const mark of removeMarks) {
                        tr.removeMark(from, to, mark)
                    }
                    // Add marks present in after but not before.
                    const addMarks: Mark[] = deserializeMarks(toAdd, state.schema)
                    for (const mark of addMarks) {
                        tr.addMark(from, to, mark)
                    }
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
    })
}

// rejectSuggestion removes text bearing suggestedInsert with the target
// id (text gone) and strips suggestedDelete marks (text stays).
// For suggestedFormatChange: strips the wrapper mark only. The
// underlying marks were never modified (the command layer reverted the
// user's toggle and stamped the suggestion on top), so dropping the
// wrapper leaves the original before-state intact.
// Then updates the suggestions Y.Map entry to REJECTED.
//
// See acceptSuggestion above for the rationale behind wrapping both
// writes in a single yDoc.transact — the same atomicity concern
// applies here.
export function rejectSuggestion(
    editor: Editor,
    suggestionId: string,
    options: ResolveOptions
): void {
    const insertRanges = collectRanges(editor, 'suggestedInsert', suggestionId)
    const deleteRanges = collectRanges(editor, 'suggestedDelete', suggestionId)
    const formatChangeRanges = collectFormatChangeRanges(editor, suggestionId)

    options.yDoc.transact(() => {
        editor
            .chain()
            .command(({ tr, state }) => {
                const deleteMarkType = state.schema.marks.suggestedDelete
                const formatChangeMarkType = state.schema.marks.suggestedFormatChange
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
                // Strip format-change wrapper marks. The original
                // before-set is already in place on the underlying
                // text (the command layer reverted the user's toggle
                // before stamping the suggestion), so reject = drop
                // the wrapper and we're done.
                for (const r of [...formatChangeRanges].reverse()) {
                    const from = tr.mapping.map(r.from)
                    const to = tr.mapping.map(r.to)
                    tr.removeMark(from, to, formatChangeMarkType)
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
    })
}
