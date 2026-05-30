import type { Editor } from '@tiptap/core'
import type { Mark } from '@tiptap/pm/model'
import type * as Y from 'yjs'
import type {
    BlockChangeAfter,
    BlockChangeBefore,
    SerializedMarks,
} from '../../webview-editor/source/suggestions/suggestion-types'
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

// BlockChangeRange carries the block's position + size plus the
// proposed before/after payload so accept can decide whether to apply
// an attr change (same type, different attrs), a type swap (different
// types), or a full block delete (after.deleted === true). Reject only
// needs to know the position to clear the suggestedBlockChange attr.
interface BlockChangeRange {
    pos: number
    nodeSize: number
    before: BlockChangeBefore
    after: BlockChangeAfter
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
            const before = Array.isArray(m.attrs.before) ? (m.attrs.before as SerializedMarks) : []
            const after = Array.isArray(m.attrs.after) ? (m.attrs.after as SerializedMarks) : []
            ranges.push({ from: pos, to: pos + node.nodeSize, before, after })
        }
    })
    return ranges
}

// collectBlockChangeRanges walks the doc and returns every block-level
// node carrying a suggestedBlockChange node attribute with the target
// suggestionId. Each entry includes the node's position, its size, and
// the parsed before/after payload that drives accept/reject.
//
// The attribute payload is JSON-serializable but stored as a plain
// object on the node. We treat any non-object as null (silent-drop
// matching the rest of the suggestion stack) and skip the entry rather
// than throwing — bad payloads should leave the doc usable, not crash
// the resolver.
function collectBlockChangeRanges(editor: Editor, suggestionId: string): BlockChangeRange[] {
    const ranges: BlockChangeRange[] = []
    editor.state.doc.descendants((node, pos) => {
        const raw = node.attrs.suggestedBlockChange
        if (!raw || typeof raw !== 'object') return true
        const payload = raw as {
            suggestionId?: unknown
            before?: unknown
            after?: unknown
        }
        if (payload.suggestionId !== suggestionId) return true
        if (!payload.before || typeof payload.before !== 'object') return true
        if (!payload.after || typeof payload.after !== 'object') return true
        ranges.push({
            pos,
            nodeSize: node.nodeSize,
            before: payload.before as BlockChangeBefore,
            after: payload.after as BlockChangeAfter,
        })
        return true
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

// isCellRange returns true iff the suggestedBlockChange entry targets
// a tableCell or tableHeader (vs paragraph/heading/listItem/blockquote).
// Cell entries need special handling on accept (row-level deletes) and
// reject (row-level addition rejection).
function isCellRange(r: BlockChangeRange): boolean {
    const t = r.before.type ?? r.after.type
    return t === 'tableCell' || t === 'tableHeader'
}

// groupCellsByParentRow returns a map from row-position to the
// BlockChangeRange entries whose cells are children of that row in
// the current doc. Used by accept (delete entire row if all its cells
// are slated for deletion) and reject (delete entire row if all its
// cells are slated as additions) to keep the resolved table well-
// formed. fixTables would otherwise refill missing cells.
function groupCellsByParentRow(
    editor: Editor,
    ranges: BlockChangeRange[]
): Map<{ rowPos: number; rowSize: number; totalCells: number }, BlockChangeRange[]> {
    // Build a position → row-summary lookup. For each cell range, find
    // its parent row in the doc and add it under the row summary entry.
    const byRowKey = new Map<
        string,
        { rowPos: number; rowSize: number; totalCells: number; cells: BlockChangeRange[] }
    >()
    for (const r of ranges) {
        const $pos = editor.state.doc.resolve(r.pos)
        // The cell's parent is the row. depth >= 1 since cells live
        // inside rows.
        for (let depth = $pos.depth; depth >= 0; depth--) {
            const ancestor = $pos.node(depth)
            if (ancestor.type.name === 'tableRow') {
                const rowPos = $pos.before(depth)
                const rowSize = ancestor.nodeSize
                const key = `${rowPos}:${rowSize}`
                let entry = byRowKey.get(key)
                if (!entry) {
                    entry = {
                        rowPos,
                        rowSize,
                        totalCells: ancestor.childCount,
                        cells: [],
                    }
                    byRowKey.set(key, entry)
                }
                entry.cells.push(r)
                break
            }
        }
    }
    const out = new Map<
        { rowPos: number; rowSize: number; totalCells: number },
        BlockChangeRange[]
    >()
    for (const v of byRowKey.values()) {
        out.set({ rowPos: v.rowPos, rowSize: v.rowSize, totalCells: v.totalCells }, v.cells)
    }
    return out
}

// acceptBlockChanges applies the accept-side logic for every
// suggestedBlockChange range. Pulled out of acceptSuggestion to keep
// the inner command body small enough for biome's cognitive-
// complexity ceiling — the cell-handling branches (added / deleted
// row-grouping / attr-change) add a fair amount of conditional
// surface.
//
// Order: cell-row-deletes (whole-row), then individual blockchange
// entries back-to-front so positions stay stable through the
// remaining writes.
function acceptBlockChanges(
    editor: Editor,
    tr: import('@tiptap/pm/state').Transaction,
    state: import('@tiptap/pm/state').EditorState,
    ranges: BlockChangeRange[]
): void {
    // Phase A — group cell ranges by parent row. If every cell in a
    // row is marked deleted, delete the whole row (back-to-front so
    // earlier rows stay positionally stable). We do the same for
    // 'every cell added in a row' deferred to the reject path (only;
    // accept of cell-added is a no-op aside from clearing the wrapper).
    const cellDeleteRanges = ranges.filter(r => isCellRange(r) && r.after.deleted === true)
    const cellsHandledByRowDelete = new Set<number>()
    if (cellDeleteRanges.length > 0) {
        const grouped = groupCellsByParentRow(editor, cellDeleteRanges)
        // Back-to-front so earlier row positions stay valid.
        const rowEntries = Array.from(grouped.entries()).sort(
            ([rowA], [rowB]) => rowB.rowPos - rowA.rowPos
        )
        for (const [rowSummary, cellsInRow] of rowEntries) {
            if (cellsInRow.length === rowSummary.totalCells) {
                const from = tr.mapping.map(rowSummary.rowPos)
                const to = tr.mapping.map(rowSummary.rowPos + rowSummary.rowSize)
                tr.delete(from, to)
                for (const c of cellsInRow) {
                    cellsHandledByRowDelete.add(c.pos)
                }
            }
        }
    }

    // Phase B — per-range application. Back-to-front.
    for (const r of [...ranges].reverse()) {
        if (cellsHandledByRowDelete.has(r.pos)) continue
        const pos = tr.mapping.map(r.pos)
        if (r.before.added === true) {
            // The cell exists. Accept means "yes, this is now part of
            // the doc" — drop the wrapper attribute. setNodeMarkup
            // with the after.attrs (which mirror the cell's current
            // attrs for an added cell) does that in one call.
            const node = tr.doc.nodeAt(pos)
            if (!node) continue
            const afterType = state.schema.nodes[r.after.type]
            if (!afterType) continue
            tr.setNodeMarkup(pos, afterType, r.after.attrs)
            continue
        }
        if (r.after.deleted === true) {
            // The block exists in the current doc (the command layer
            // restored it when the user proposed the delete). Honor
            // the proposal by deleting it now. The size we stored is
            // in the pre-resolve doc's coordinates; map the end
            // through tr.mapping to handle any prior steps in this
            // transaction.
            const end = tr.mapping.map(r.pos + r.nodeSize)
            tr.delete(pos, end)
            continue
        }
        const afterType = state.schema.nodes[r.after.type]
        if (!afterType) continue
        // setNodeMarkup with the explicit after.attrs lets the
        // schema's default for suggestedBlockChange (null) take over
        // — the wrapper attribute is dropped at the same time the
        // proposed type + attrs land.
        tr.setNodeMarkup(pos, afterType, r.after.attrs)
    }
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
    const blockChangeRanges = collectBlockChangeRanges(editor, suggestionId)

    options.yDoc.transact(() => {
        editor
            .chain()
            .command(({ tr, state }) => {
                const insertMarkType = state.schema.marks.suggestedInsert
                const formatChangeMarkType = state.schema.marks.suggestedFormatChange
                // Resolve block-changes FIRST. A kind='delete' entry
                // deletes the entire block (including text bearing
                // suggestedDelete marks with the same id); processing
                // it before the suggestedDelete loop avoids that loop
                // touching text that's about to vanish. For attr/
                // type-swap entries, setNodeMarkup with after.attrs
                // both clears the wrapper attribute (default null
                // applies when no explicit value is passed) and lands
                // the proposed structure.
                //
                // Cell-specific accept paths (Phase 5 Task 14):
                //   - before.added=true → clear the wrapper attr; the
                //     cell already exists and stays.
                //   - after.deleted=true on a cell → delete the cell
                //     range. If every cell in the parent row carries
                //     deleted=true with this id, delete the row
                //     instead (so fixTables doesn't refill a missing
                //     cell into the now-empty row).
                //
                // Back-to-front so earlier positions stay stable.
                acceptBlockChanges(editor, tr, state, blockChangeRanges)
                // Strip insert marks (back-to-front so positions stay stable).
                for (const r of [...insertRanges].reverse()) {
                    const from = tr.mapping.map(r.from)
                    const to = tr.mapping.map(r.to)
                    if (to <= from) continue
                    tr.removeMark(from, to, insertMarkType)
                }
                // Remove delete-marked ranges (back-to-front, re-mapping
                // through any prior steps in this transaction).
                for (const r of [...deleteRanges].reverse()) {
                    const from = tr.mapping.map(r.from)
                    const to = tr.mapping.map(r.to)
                    if (to <= from) continue
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
                    if (to <= from) continue
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

// rejectBlockChanges applies the reject-side logic for every
// suggestedBlockChange range. For most kinds, reject is just
// "clear the wrapper attribute"; the doc is already in the before-
// state because the command layer reverted the user's structural
// change before stamping the suggestion. Cell-added entries are the
// exception — those represent a proposed addition that, on reject,
// must be removed from the doc.
function rejectBlockChanges(
    editor: Editor,
    tr: import('@tiptap/pm/state').Transaction,
    ranges: BlockChangeRange[]
): void {
    // Phase A — group cell-added ranges by parent row. If every cell
    // in a row was added, delete the entire row (back-to-front so
    // earlier rows stay positionally stable).
    const cellAddRanges = ranges.filter(r => isCellRange(r) && r.before.added === true)
    const cellsHandledByRowDelete = new Set<number>()
    if (cellAddRanges.length > 0) {
        const grouped = groupCellsByParentRow(editor, cellAddRanges)
        const rowEntries = Array.from(grouped.entries()).sort(
            ([rowA], [rowB]) => rowB.rowPos - rowA.rowPos
        )
        for (const [rowSummary, cellsInRow] of rowEntries) {
            if (cellsInRow.length === rowSummary.totalCells) {
                const from = tr.mapping.map(rowSummary.rowPos)
                const to = tr.mapping.map(rowSummary.rowPos + rowSummary.rowSize)
                tr.delete(from, to)
                for (const c of cellsInRow) {
                    cellsHandledByRowDelete.add(c.pos)
                }
            }
        }
    }

    // Phase B — per-range application.
    for (const r of [...ranges].reverse()) {
        if (cellsHandledByRowDelete.has(r.pos)) continue
        const pos = tr.mapping.map(r.pos)
        if (r.before.added === true) {
            // Cell-added: delete the cell. The row's column count
            // may shift, but a partial reject across rows still
            // leaves a well-formed table (each row's cell count is
            // the same — every "before.added" cell in the row was
            // part of the original addRow proposal).
            const end = tr.mapping.map(r.pos + r.nodeSize)
            tr.delete(pos, end)
            continue
        }
        const node = tr.doc.nodeAt(pos)
        if (!node) continue
        const nextAttrs: Record<string, unknown> = { ...node.attrs }
        nextAttrs.suggestedBlockChange = null
        tr.setNodeMarkup(pos, null, nextAttrs)
    }
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
    const blockChangeRanges = collectBlockChangeRanges(editor, suggestionId)

    options.yDoc.transact(() => {
        editor
            .chain()
            .command(({ tr, state }) => {
                const deleteMarkType = state.schema.marks.suggestedDelete
                const formatChangeMarkType = state.schema.marks.suggestedFormatChange
                // Reject block-changes: the block is already in its
                // before-state on screen (the command layer reverted
                // the user's structural change before stamping the
                // suggestion). Clearing the suggestedBlockChange
                // attribute is the only structural work needed for
                // most cases.
                //
                // Cell-specific reject paths (Phase 5 Task 14):
                //   - before.added=true → DELETE the cell. It was a
                //     proposed addition that's being rejected, so it
                //     shouldn't remain in the doc. If every cell in the
                //     parent row is being rejected, delete the row
                //     (else fixTables would re-fill missing cells).
                //   - after.deleted=true → just clear the wrapper.
                //     Inline text already loses its suggestedDelete
                //     mark via the deleteRanges loop below.
                //
                // For kind='delete' (non-cell) specifically, the
                // companion suggestedDelete marks on inline content
                // are stripped by the deleteRanges loop below.
                //
                // Back-to-front for positional safety.
                rejectBlockChanges(editor, tr, blockChangeRanges)
                // Remove insert-marked ranges (back-to-front).
                for (const r of [...insertRanges].reverse()) {
                    const from = tr.mapping.map(r.from)
                    const to = tr.mapping.map(r.to)
                    if (to <= from) continue
                    tr.delete(from, to)
                }
                // Strip delete marks (re-mapped through any prior deletes).
                // This also strips the suggestedDelete marks the command
                // layer added to inline content inside a rejected
                // block-delete, restoring the text to its visible state
                // without strikethrough.
                for (const r of [...deleteRanges].reverse()) {
                    const from = tr.mapping.map(r.from)
                    const to = tr.mapping.map(r.to)
                    if (to <= from) continue
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
                    if (to <= from) continue
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
