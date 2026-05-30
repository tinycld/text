import { Extension } from '@tiptap/core'
import type { MarkType, Node as PMNode, Slice } from '@tiptap/pm/model'
import { type EditorState, Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import { ReplaceAroundStep, ReplaceStep } from '@tiptap/pm/transform'
import type * as Y from 'yjs'
import { EDITOR_MODE_SUGGESTING, type EditorModeStore } from '../../stores/editor-mode-store'
import { type BlockChange, extractBlockChanges, isBlockDeleteStep } from './block-change-utils'
import { extractMarkToggles, summarizeToggles } from './format-change-utils'
import { createSuggestionSession, type SuggestionSession } from './session-grouping'
import { SuggestionsMap } from './suggestions-map'
import { extractTableChanges, hasTableChanges, type TableChange } from './table-change-utils'

// Shared context the per-step handlers need. Pulled out so the
// step-loop body in appendTransaction stays small enough to keep
// cognitive complexity under biome's noExcessiveCognitiveComplexity
// threshold (max 45). The fields are immutable for the lifetime of
// one appendTransaction call.
interface StepContext {
    out: Transaction
    insertMarkType: MarkType
    deleteMarkType: MarkType
    formatChangeMarkType: MarkType
    suggestionId: string
    authorId: string
    now: number
}

// True iff every text node in `slice` is already marked as the
// current author's active-session insertion. Drives Case 2d — the
// author retracting their own pending suggestion within the idle
// window keeps the delete (no suggestedDelete restore).
function isAllOwnActiveSuggestion(slice: Slice, suggestionId: string): boolean {
    if (slice.content.size === 0) return false
    let allOwn = true
    slice.content.descendants(node => {
        if (node.isText) {
            const m = node.marks.find(
                mark =>
                    mark.type.name === 'suggestedInsert' && mark.attrs.suggestionId === suggestionId
            )
            if (!m) allOwn = false
        }
        return true
    })
    return allOwn
}

function applyInsertStep(ctx: StepContext, from: number, slice: Slice): void {
    // For inserts: the step's `from` is in stepDoc (pre-step)
    // coordinates but coincides with the start of the inserted
    // content in post-step coordinates (inserts don't shift positions
    // at or to the left of their `from`). Map through any prior
    // steps already appended to `out` for safety in multi-step bundles.
    //
    // The mark range spans only the actual inserted *content* — i.e.
    // `slice.content.size` minus the slice's open boundaries on each
    // side. For a structural insert like pressing Enter at end of doc
    // (slice = `<p></p><p></p>` with openStart=openEnd=1) the open
    // tokens describe how the slice attaches to the surrounding
    // structure rather than new positions inside the doc; subtracting
    // them yields the true post-step width. Without this, addMark is
    // called with `to` past the new doc end and the underlying
    // Fragment.nodesBetween crashes with "nodeSize of undefined".
    const insertWidth = slice.content.size - slice.openStart - slice.openEnd
    if (insertWidth <= 0) return
    const mapped = ctx.out.mapping.map(from)
    ctx.out.addMark(
        mapped,
        mapped + insertWidth,
        ctx.insertMarkType.create({
            suggestionId: ctx.suggestionId,
            authorId: ctx.authorId,
            ts: ctx.now,
        })
    )
}

// Returns true if the delete actually drew a restore + mark; false
// when Case 2d applied (the delete was allowed to stand).
function applyDeleteStep(
    ctx: StepContext,
    tr: Transaction,
    stepIndex: number,
    from: number,
    to: number
): boolean {
    // For deletes: pull the deleted slice from the pre-step doc
    // (tr.docs[i] is the doc *before* step i was applied; if i===0,
    // that's the doc we'd see in oldState).
    const oldDoc = tr.docs[stepIndex]
    const deletedSlice = oldDoc.slice(from, to)

    // Case 2d: the deleted range was entirely covered by the current
    // author's CURRENT active suggestion. Let the delete stand — the
    // author is retracting their own pending work within the idle window.
    if (isAllOwnActiveSuggestion(deletedSlice, ctx.suggestionId)) {
        return false
    }

    // Restore + mark. Insert the slice at the mapped pre-step
    // position (in `out`'s frame, which starts at newState). For a
    // single-step delete transaction, that's exactly `from`.
    const mappedFrom = ctx.out.mapping.map(from)
    ctx.out.insert(mappedFrom, deletedSlice.content)
    ctx.out.addMark(
        mappedFrom,
        mappedFrom + deletedSlice.content.size,
        ctx.deleteMarkType.create({
            suggestionId: ctx.suggestionId,
            authorId: ctx.authorId,
            ts: ctx.now,
        })
    )
    return true
}

function applyReplaceStep(
    ctx: StepContext,
    tr: Transaction,
    stepIndex: number,
    from: number,
    to: number,
    sliceSize: number
): void {
    // Replace: typing/pasting over a selection. PM has already
    // removed [from, to) and inserted the new slice at `from` in the
    // post-step doc. We treat this as a delete (preserve the old
    // range as `suggestedDelete`) AND an insert (mark the new range
    // as `suggestedInsert`), sharing the same suggestionId so they
    // group as one logical edit.
    const oldDoc = tr.docs[stepIndex]
    const deletedSlice = oldDoc.slice(from, to)

    // Case 2d also applies to the delete-side of a replace: if the
    // entire old range was the current author's active-session
    // insertion, we let the delete stand and only stamp the new content.
    const skipRestore = isAllOwnActiveSuggestion(deletedSlice, ctx.suggestionId)

    // In post-step coordinates the new slice starts at `from` (PM
    // has already done the splice). Map through prior appended steps.
    const newContentStart = ctx.out.mapping.map(from)

    if (!skipRestore) {
        // Restore the deleted slice BEFORE the new content with a
        // suggestedDelete mark, so the document reads: [old struck][new ins].
        ctx.out.insert(newContentStart, deletedSlice.content)
        ctx.out.addMark(
            newContentStart,
            newContentStart + deletedSlice.content.size,
            ctx.deleteMarkType.create({
                suggestionId: ctx.suggestionId,
                authorId: ctx.authorId,
                ts: ctx.now,
            })
        )
    }

    // After the optional restore, `from` now maps to the position
    // immediately after the restored slice — exactly the start of
    // the newly-inserted content. (If Case 2d applied and we didn't
    // insert anything, this maps to the same position as newContentStart.)
    const insertStart = ctx.out.mapping.map(from)
    ctx.out.addMark(
        insertStart,
        insertStart + sliceSize,
        ctx.insertMarkType.create({
            suggestionId: ctx.suggestionId,
            authorId: ctx.authorId,
            ts: ctx.now,
        })
    )
}

// applyFormatChangeStep handles all AddMark/RemoveMark steps in `tr`
// as a single suggested-format-change. The user's mark toggles have
// already landed in `newState` (appendTransaction sees post-step doc),
// so we (a) undo each toggle on `out` — re-add removed marks, remove
// added marks — and (b) stamp a single suggestedFormatChange mark
// over the merged [from, to) range carrying serialized before/after
// snapshots. The resolver (Task 5) re-applies the after-set on accept
// or leaves the before-set intact on reject.
//
// Why undo first instead of leaving the user's marks visible: the
// suggestion is exactly that — proposed, not applied. The visual
// hint that a format change is pending comes from the decoration
// plugin (Task 6), which renders the after-set as a styled overlay
// on the suggestedFormatChange range. Leaving the raw bold/italic
// mark on the run would make the doc render as if the change were
// already accepted, defeating the purpose of suggestion mode.
function applyFormatChangeStep(
    ctx: StepContext,
    tr: Transaction,
    oldState: EditorState,
    newState: EditorState
): boolean {
    const toggles = extractMarkToggles(tr)
    if (toggles.length === 0) return false

    // Undo each toggle on the output transaction. The output is
    // anchored at newState's doc, so we reverse what landed: re-add
    // marks the user removed and remove marks the user added. We map
    // the toggle ranges through `out.mapping` for safety against any
    // prior steps appended in this iteration (currently none, since
    // format changes run first, but the discipline is cheap).
    for (const t of toggles) {
        const from = ctx.out.mapping.map(t.from)
        const to = ctx.out.mapping.map(t.to)
        if (t.isAdd) {
            ctx.out.removeMark(from, to, t.mark)
        } else {
            ctx.out.addMark(from, to, t.mark)
        }
    }

    const summary = summarizeToggles(toggles, oldState, newState)
    const fcFrom = ctx.out.mapping.map(summary.from)
    const fcTo = ctx.out.mapping.map(summary.to)
    ctx.out.addMark(
        fcFrom,
        fcTo,
        ctx.formatChangeMarkType.create({
            suggestionId: ctx.suggestionId,
            authorId: ctx.authorId,
            ts: ctx.now,
            before: summary.before,
            after: summary.after,
        })
    )
    return true
}

// applyBlockChangeStep handles all block-level changes the user emitted
// in `tr` (setBlockType, setNodeAttribute, block delete) as
// suggestedBlockChange node attributes plus, for kind='delete',
// companion suggestedDelete marks on the inline content. Mirrors the
// format-change branch's "undo + stamp" pattern:
//
//   - kind='attr' / 'type-swap': revert the user's change on `out` by
//     calling setNodeMarkup with the before-type + before-attrs, then
//     also write the suggestedBlockChange payload as a node attribute.
//     A single setNodeMarkup call carries both — the before-attrs
//     restore the user-facing shape, and the suggestedBlockChange
//     entry records the proposed transition.
//
//   - kind='delete': the block is gone from newState. Re-insert the
//     original block node at the mapped position, stamp the
//     suggestedBlockChange attribute with after.deleted=true, and add
//     suggestedDelete marks over the inline content so the
//     strikethrough decoration applies to the text.
//
// Block changes take precedence over the format-change branch in the
// main appendTransaction loop. The reason: a type-swap from paragraph
// to heading might incidentally introduce attribute marks
// (clearIncompatible runs inside setBlockType to strip marks the new
// type doesn't allow). Those incidental mark-toggle steps should NOT
// be re-stamped as format changes — they're a side-effect of the
// type swap, not a separate proposal. By detecting block changes
// first, the format-change extractMarkToggles call still runs but on
// transactions where structural intent dominates we accept the small
// drift (a format-change wrapper might co-exist with the
// suggestedBlockChange entry, both pointing at the same suggestionId).
//
// Returns the set of step INDICES the block-change handling consumed
// so the caller's regular ReplaceStep dispatch skips them. AttrStep
// and ReplaceAroundStep aren't in that loop in the first place; the
// returned set therefore only needs to cover ReplaceStep block-deletes
// to prevent the existing text-delete path from double-restoring.
function applyBlockChangeStep(
    ctx: StepContext,
    tr: Transaction,
    oldState: EditorState,
    schema: EditorState['schema']
): { consumedReplaceSteps: Set<number>; hadEffect: boolean } {
    const consumed = new Set<number>()
    const changes = extractBlockChanges(tr, oldState)
    if (changes.length === 0) {
        return { consumedReplaceSteps: consumed, hadEffect: false }
    }

    // Identify ReplaceStep indices that correspond to block deletes so
    // the caller can skip them in its text-delete path.
    for (let i = 0; i < tr.steps.length; i++) {
        const step = tr.steps[i]
        if (step instanceof ReplaceStep && isBlockDeleteStep(step, oldState)) {
            consumed.add(i)
        }
    }

    // Process back-to-front so earlier positions stay stable while we
    // apply structural edits on `out`.
    const sorted = [...changes].sort((a, b) => b.pos - a.pos)
    for (const change of sorted) {
        applyOneBlockChange(ctx, change, schema)
    }
    return { consumedReplaceSteps: consumed, hadEffect: true }
}

function applyOneBlockChange(
    ctx: StepContext,
    change: BlockChange,
    schema: EditorState['schema']
): void {
    const payload = {
        suggestionId: ctx.suggestionId,
        authorId: ctx.authorId,
        ts: ctx.now,
        before: { type: change.beforeType, attrs: change.beforeAttrs },
        after:
            change.kind === 'delete'
                ? {
                      type: change.beforeType,
                      attrs: change.beforeAttrs,
                      deleted: true,
                  }
                : { type: change.afterType, attrs: change.afterAttrs },
    }

    if (change.kind === 'attr' || change.kind === 'type-swap') {
        applyBlockAttrOrTypeSwap(ctx, change, schema, payload)
        return
    }
    applyBlockDelete(ctx, change, schema, payload)
}

function applyBlockAttrOrTypeSwap(
    ctx: StepContext,
    change: Extract<BlockChange, { kind: 'attr' | 'type-swap' }>,
    schema: EditorState['schema'],
    payload: Record<string, unknown>
): void {
    // The block exists in newState at the mapped position. Reset its
    // type + attrs to the before-state and bake in our
    // suggestedBlockChange payload in a single setNodeMarkup call —
    // this both reverts the user's change AND records the proposal.
    const mappedPos = ctx.out.mapping.map(change.pos)
    const beforeType = schema.nodes[change.beforeType]
    if (!beforeType) return
    const node = ctx.out.doc.nodeAt(mappedPos)
    if (!node) return
    const nextAttrs: Record<string, unknown> = {
        ...change.beforeAttrs,
        suggestedBlockChange: payload,
    }
    ctx.out.setNodeMarkup(mappedPos, beforeType, nextAttrs)
}

// applyTableChangeStep handles cell-level changes the user emitted in
// `tr` (addRowAfter / addColumnAfter / deleteRow / deleteColumn /
// setCellAttribute / merge / split) as per-cell suggestedBlockChange
// node attributes. Mirrors the block-change branch's "undo + stamp"
// pattern but operates on table cells:
//
//   - cell-added: the cell already exists in newState (e.g. addRowAfter
//     inserted a fresh row with N cells). Stamp suggestedBlockChange
//     on each cell at its newState position. before.added=true
//     signals "this cell didn't exist before the suggestion."
//
//   - cell-deleted: the cell was removed by the user's transaction. Use
//     the same slice-restoration trick the text-delete path uses
//     (insert tr.docs[i].slice(from, to).content at the mapped position)
//     so the cell + its enclosing structure (row, if a whole row was
//     deleted) return. The restore-walk records each restored cell's
//     final position and stamps it with after.deleted=true plus
//     suggestedDelete marks on the inline content.
//
//   - cell-attr: revert the user's setNodeMarkup (the cell's
//     ReplaceAroundStep) by writing setNodeMarkup on the cell with
//     before.attrs, then bake in the suggestedBlockChange payload.
//
// Table changes take precedence over the block-change branch — table
// operations emit ReplaceStep / ReplaceAroundStep shapes that the
// block branch would mis-classify as block-deletes or block-attr
// changes (tableCell is no longer in TARGET_BLOCK_TYPES, but
// row-delete steps would still flow through processReplaceSteps as
// text-deletes). Detecting tables first lets us consume those steps
// and prevent double-handling.
//
// Returns the set of step indices the table-change handling consumed
// so the caller's regular ReplaceStep / ReplaceAroundStep dispatch
// skips them. AttrStep is never emitted by table operations (tables
// use setNodeMarkup, which emits ReplaceAroundStep), so AttrStep
// indices need no special handling here.
function applyTableChangeStep(
    ctx: StepContext,
    tr: Transaction,
    oldState: EditorState,
    newState: EditorState
): { consumedSteps: Set<number>; hadEffect: boolean } {
    const consumed = new Set<number>()
    if (!hasTableChanges(tr, oldState)) {
        return { consumedSteps: consumed, hadEffect: false }
    }
    const changes = extractTableChanges(tr, oldState, newState)
    if (changes.length === 0) {
        return { consumedSteps: consumed, hadEffect: false }
    }

    // Phase 1 — restore deleted cells (and walk the restored content to
    // stamp suggestedBlockChange + suggestedDelete marks). We walk
    // tr's steps in order; for each ReplaceStep that's part of a
    // table operation we re-insert its deleted slice via ctx.out and
    // stamp the cells inside that fresh insertion before they could
    // be displaced by a subsequent step's restore. Stamping inside
    // this loop avoids the need to map an old-doc cell position
    // (which is in the DELETED range) through any complex mapping —
    // we already know exactly where each restored cell landed in
    // ctx.out.doc.
    const deletedCellPositions = new Set<number>()
    for (let i = 0; i < tr.steps.length; i++) {
        const step = tr.steps[i]
        if (step instanceof ReplaceStep) {
            if (isTableReplaceStep(step, tr, i, oldState)) {
                consumed.add(i)
                restoreAndStampDeletedCells(ctx, step, tr, i, oldState, deletedCellPositions)
            }
        } else if (step instanceof ReplaceAroundStep) {
            if (isCellAroundStep(step, tr, i, oldState)) {
                consumed.add(i)
            }
        }
    }

    // Phase 2 — stamp the suggestedBlockChange payload on cells that
    // weren't already stamped during the delete restore (i.e. the
    // cell-added and cell-attr entries). Back-to-front so earlier
    // positions stay stable when we run setNodeMarkup on a later
    // cell that shifts things AFTER it.
    const otherChanges = changes.filter(c => c.kind !== 'cell-deleted')
    const sorted = [...otherChanges].sort((a, b) => b.pos - a.pos)
    for (const change of sorted) {
        applyOneTableChange(ctx, change, newState.schema)
    }
    return { consumedSteps: consumed, hadEffect: true }
}

// isTableReplaceStep returns true iff this ReplaceStep is part of a
// table operation (its deleted range fully encloses one or more cells
// or its inserted slice contains cells). Used to mark the step
// consumed so processReplaceSteps doesn't run its text-delete path
// over the same range.
function isTableReplaceStep(
    step: ReplaceStep,
    tr: Transaction,
    stepIndex: number,
    oldState: EditorState
): boolean {
    const preStepDoc = tr.docs[stepIndex] ?? oldState.doc
    let found = false
    preStepDoc.nodesBetween(step.from, step.to, (node, nodePos) => {
        if (found) return false
        if (node.type.name !== 'tableCell' && node.type.name !== 'tableHeader') return true
        if (nodePos >= step.from && nodePos + node.nodeSize <= step.to) {
            found = true
            return false
        }
        return true
    })
    if (found) return true
    if (step.slice.content.size > 0) {
        let foundInSlice = false
        step.slice.content.descendants(node => {
            if (foundInSlice) return false
            if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
                foundInSlice = true
                return false
            }
            return true
        })
        if (foundInSlice) return true
    }
    return false
}

function isCellAroundStep(
    step: ReplaceAroundStep,
    tr: Transaction,
    stepIndex: number,
    oldState: EditorState
): boolean {
    const preStepDoc = tr.docs[stepIndex] ?? oldState.doc
    const oldNode = preStepDoc.nodeAt(step.from)
    if (oldNode && (oldNode.type.name === 'tableCell' || oldNode.type.name === 'tableHeader')) {
        return true
    }
    return false
}

// restoreAndStampDeletedCells re-inserts the deleted slice from a
// table-related ReplaceStep so the cells (and any enclosing row) come
// back into the visible doc, then walks the restored content to
// stamp suggestedBlockChange (with after.deleted=true) plus
// suggestedDelete marks on each cell's inline text.
//
// Insert-only steps (sliceSize > 0, from === to) need no restoration:
// the inserted cells are already in newState. The Phase 2 stamp loop
// in applyTableChangeStep handles them. Pure-delete steps
// (sliceSize === 0, from < to) restore the deleted content. Replace
// steps (from < to, sliceSize > 0) restore the old content before
// the new content — same shape as applyReplaceStep but without the
// insert-side marking.
//
// `restoredPositions` carries the (out-doc) positions of every cell
// stamped here, so the caller's Phase 2 can avoid double-stamping a
// cell that's also recorded as cell-attr (theoretically impossible
// for a single user transaction but defensive against future steps).
function restoreAndStampDeletedCells(
    ctx: StepContext,
    step: ReplaceStep,
    tr: Transaction,
    stepIndex: number,
    oldState: EditorState,
    restoredPositions: Set<number>
): void {
    const isDelete = step.from < step.to && step.slice.content.size === 0
    if (!isDelete) return
    const preStepDoc = tr.docs[stepIndex] ?? oldState.doc
    const deletedSlice = preStepDoc.slice(step.from, step.to)
    if (deletedSlice.content.size === 0) return
    const mappedFrom = ctx.out.mapping.map(step.from)
    ctx.out.insert(mappedFrom, deletedSlice.content)

    // Walk the now-restored content (in ctx.out.doc) and stamp each
    // cell. The inserted content lives at [mappedFrom, mappedFrom +
    // deletedSlice.content.size). We walk the doc range rather than
    // the slice directly to get ctx.out.doc nodes (so subsequent
    // setNodeMarkup writes see consistent state).
    const insertEnd = mappedFrom + deletedSlice.content.size
    stampDeletedCellsInRange(ctx, mappedFrom, insertEnd, restoredPositions)
}

// Walk a range in ctx.out.doc, stamp suggestedBlockChange (after.deleted=true)
// on every cell, and add suggestedDelete marks across each cell's
// inline text. Each visited cell position is added to
// `restoredPositions` so Phase 2 can skip duplicates.
function stampDeletedCellsInRange(
    ctx: StepContext,
    from: number,
    to: number,
    restoredPositions: Set<number>
): void {
    // Collect cell positions first (back-to-front order so the
    // subsequent setNodeMarkup writes don't shift later cells).
    const cells: Array<{ pos: number; node: PMNode; cellType: string }> = []
    ctx.out.doc.nodesBetween(from, to, (node, pos) => {
        if (node.type.name !== 'tableCell' && node.type.name !== 'tableHeader') return true
        cells.push({ pos, node, cellType: node.type.name })
        return false
    })
    // Stamp back-to-front. setNodeMarkup on a cell DOES NOT change the
    // cell's own position; only later cells' positions move when an
    // earlier cell's content grows or shrinks. setNodeMarkup with the
    // same nodeSize is positionally stable. We still process back-
    // to-front as a defensive discipline.
    for (let i = cells.length - 1; i >= 0; i--) {
        const c = cells[i]
        restoredPositions.add(c.pos)
        const cellNodeType = ctx.out.doc.type.schema.nodes[c.cellType]
        if (!cellNodeType) continue
        const cleanedAttrs = stripTrackingAttrsLocal(c.node.attrs)
        const payload = {
            suggestionId: ctx.suggestionId,
            authorId: ctx.authorId,
            ts: ctx.now,
            before: { type: c.cellType, attrs: cleanedAttrs },
            after: { type: c.cellType, attrs: cleanedAttrs, deleted: true },
        }
        const nextAttrs: Record<string, unknown> = {
            ...cleanedAttrs,
            suggestedBlockChange: payload,
        }
        ctx.out.setNodeMarkup(c.pos, cellNodeType, nextAttrs)
        markTextInsideNode(ctx, c.node, c.pos)
    }
}

function applyOneTableChange(
    ctx: StepContext,
    change: TableChange,
    schema: EditorState['schema']
): void {
    if (change.kind === 'cell-added') {
        applyCellAdded(ctx, change, schema)
        return
    }
    if (change.kind === 'cell-attr') {
        applyCellAttr(ctx, change, schema)
        return
    }
    // cell-deleted entries are stamped during the restore loop in
    // applyTableChangeStep (so the position arithmetic stays simple);
    // they never reach this function.
}

function applyCellAdded(
    ctx: StepContext,
    change: Extract<TableChange, { kind: 'cell-added' }>,
    schema: EditorState['schema']
): void {
    // The cell already exists at newState position `change.pos`. Stamp
    // the suggestedBlockChange attribute via setNodeMarkup. before.added
    // signals "this cell didn't exist pre-suggestion" so the resolve
    // path can choose between keep-on-accept and delete-on-reject.
    const mappedPos = ctx.out.mapping.map(change.pos)
    const cellType = schema.nodes[change.cellType]
    if (!cellType) return
    const node = ctx.out.doc.nodeAt(mappedPos)
    if (!node) return
    if (node.type.name !== change.cellType) return
    const cleanedAttrs = stripTrackingAttrsLocal(node.attrs)
    const payload = {
        suggestionId: ctx.suggestionId,
        authorId: ctx.authorId,
        ts: ctx.now,
        before: { type: change.cellType, attrs: cleanedAttrs, added: true },
        after: { type: change.cellType, attrs: cleanedAttrs },
    }
    const nextAttrs: Record<string, unknown> = {
        ...cleanedAttrs,
        suggestedBlockChange: payload,
    }
    ctx.out.setNodeMarkup(mappedPos, cellType, nextAttrs)
}

function applyCellAttr(
    ctx: StepContext,
    change: Extract<TableChange, { kind: 'cell-attr' }>,
    schema: EditorState['schema']
): void {
    const mappedPos = ctx.out.mapping.map(change.pos)
    const cellType = schema.nodes[change.cellType]
    if (!cellType) return
    const node = ctx.out.doc.nodeAt(mappedPos)
    if (!node || node.type.name !== change.cellType) return
    // Revert the attr change by writing setNodeMarkup with before-attrs,
    // and bake in the suggestedBlockChange payload at the same time.
    const payload = {
        suggestionId: ctx.suggestionId,
        authorId: ctx.authorId,
        ts: ctx.now,
        before: { type: change.cellType, attrs: change.beforeAttrs },
        after: { type: change.cellType, attrs: change.afterAttrs },
    }
    const nextAttrs: Record<string, unknown> = {
        ...change.beforeAttrs,
        suggestedBlockChange: payload,
    }
    ctx.out.setNodeMarkup(mappedPos, cellType, nextAttrs)
}

// Strip the suggestedBlockChange tracking attr from a node's attrs
// shallow copy. Mirror of block-change-utils's helper — duplicated
// here to keep the module boundary clean and avoid circular imports
// down the line.
function stripTrackingAttrsLocal(attrs: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const key in attrs) {
        if (key === 'suggestedBlockChange') continue
        out[key] = attrs[key]
    }
    return out
}

// markTextInsideNode walks the inline content of `node` (a cell that
// was just restored) and adds a suggestedDelete mark over every text
// node. `containerPos` is the cell's position in ctx.out.doc. Text
// nodes inside the cell live at containerPos + 1 (open) + per-child
// offsets.
function markTextInsideNode(ctx: StepContext, node: PMNode, containerPos: number): void {
    node.descendants((child, relPos) => {
        if (!child.isText) return true
        const absFrom = containerPos + 1 + relPos
        const absTo = absFrom + child.nodeSize
        ctx.out.addMark(
            absFrom,
            absTo,
            ctx.deleteMarkType.create({
                suggestionId: ctx.suggestionId,
                authorId: ctx.authorId,
                ts: ctx.now,
            })
        )
        return true
    })
}

function applyBlockDelete(
    ctx: StepContext,
    change: Extract<BlockChange, { kind: 'delete' }>,
    schema: EditorState['schema'],
    payload: Record<string, unknown>
): void {
    // The block was removed by the user's transaction. Re-insert a
    // fresh copy (with the before-attrs plus our suggestedBlockChange
    // payload baked in) at the mapped position, then add
    // suggestedDelete marks across the restored inline content so the
    // strikethrough decoration applies.
    const beforeType = schema.nodes[change.beforeType]
    if (!beforeType) return

    const nextAttrs: Record<string, unknown> = {
        ...change.beforeAttrs,
        suggestedBlockChange: payload,
    }
    const newBlock = beforeType.create(
        nextAttrs,
        change.beforeNode.content,
        change.beforeNode.marks
    )

    const mappedPos = ctx.out.mapping.map(change.pos)
    ctx.out.insert(mappedPos, newBlock)
    // The inserted block's inline content sits at [mappedPos + 1,
    // mappedPos + 1 + content.size). addMark only applies to inline
    // nodes inside that range, so the suggestedBlockChange node
    // attribute is unaffected.
    const innerFrom = mappedPos + 1
    const innerTo = innerFrom + change.beforeNode.content.size
    if (innerTo > innerFrom) {
        ctx.out.addMark(
            innerFrom,
            innerTo,
            ctx.deleteMarkType.create({
                suggestionId: ctx.suggestionId,
                authorId: ctx.authorId,
                ts: ctx.now,
            })
        )
    }
}

// Plugin key tag for transactions the command layer itself appends.
// We check this in appendTransaction to short-circuit re-entry: when
// y-prosemirror or another plugin echoes our own appended transaction
// back through us, we must not re-mark or re-restore.
const PLUGIN_KEY = new PluginKey('tinycld:suggestion-command-layer')

export interface SuggestionCommandLayerOptions {
    modeStore: EditorModeStore
    yDoc: Y.Doc
}

// createSuggestionCommandPlugin builds the ProseMirror plugin that
// implements the suggesting-mode rewrite layer. It hooks into
// appendTransaction so it observes every user-driven transaction and
// emits a corrective transaction that:
//
//   - INSERTS: wraps the inserted range in suggestedInsert with the
//     active session's suggestionId + authorId + ts.
//   - DELETES: restores the deleted slice in place (so the user's
//     change is visually "tracked" not destructive) and wraps it in
//     suggestedDelete carrying the same attribution.
//   - FORMAT TOGGLES (Phase 5): undoes the user's mark toggle and
//     stamps suggestedFormatChange over the range with before/after
//     snapshots of the affected marks. The raw bold/italic/link mark
//     itself is reverted so the doc doesn't render the change as if
//     accepted; the decoration plugin (Task 6) provides the visual
//     overlay that signals "this format change is pending".
//
// Special case 2d (deleting one's own active-suggestion content within
// the idle window): the delete is allowed to stand. This is how
// authors retract a freshly-typed character — the suggestion isn't
// fossilized until the idle window elapses, and within the window the
// author may freely edit their own pending suggestion.
//
// Sessions are keyed by the editor's identity (userOrgId in the mode
// store). When the identity changes, the previous session is dropped
// so the next touch mints a fresh suggestionId — the per-author
// session is the right boundary for "this person's pending work".
//
// The suggestions Y.Map entry is created lazily on first touch of a
// new suggestionId. y-prosemirror bundles the PM step transaction and
// the Y.Map.set into a single Yjs transaction at commit time, so the
// doc + suggestions index update atomically — partial-fail isn't
// possible.
export function createSuggestionCommandPlugin(options: SuggestionCommandLayerOptions): Plugin {
    const { modeStore, yDoc } = options
    const suggestionsMap = new SuggestionsMap(yDoc)
    // Sessions are per-author; if the editor's identity changes (user
    // signs out/in, OTP guest session ends, etc.), we discard the
    // previous session so the next touch mints a fresh suggestionId.
    let session: SuggestionSession | null = null
    let sessionAuthorId: string | null = null

    const getSession = (authorId: string): SuggestionSession => {
        if (sessionAuthorId !== authorId) {
            session = createSuggestionSession(authorId)
            sessionAuthorId = authorId
        }
        // biome-ignore lint/style/noNonNullAssertion: session is set when authorId differs
        return session!
    }

    return new Plugin({
        key: PLUGIN_KEY,
        appendTransaction(transactions, oldState, newState) {
            const { mode, identity } = modeStore.getState()
            if (mode !== EDITOR_MODE_SUGGESTING) return null
            if (!identity) return null
            if (transactions.length === 0) return null

            // Skip transactions originated by the command layer itself
            // (avoid infinite recursion when y-prosemirror or other
            // plugins re-emit our appended transactions).
            if (transactions.some(tr => tr.getMeta(PLUGIN_KEY))) return null

            // Skip y-prosemirror sync transactions. When a peer (or
            // OUR OWN edit pipeline like the resolver's mark-strip
            // commit) generates a Yjs update, y-prosemirror replays
            // it back into the editor as a fresh PM transaction
            // tagged with the 'y-sync$' meta. Without this guard, the
            // command layer would treat that replay as a fresh user
            // edit, re-stamp the affected range with suggestedInsert
            // marks, and recreate the suggestions Y.Map entry — the
            // resolved suggestion would silently respawn as 'open'.
            // The guard is intentionally broad: any transaction with
            // a y-sync$ meta is not user-driven.
            if (transactions.some(tr => tr.getMeta('y-sync$') != null)) return null

            // Only act on user-driven content changes.
            if (!transactions.some(tr => tr.docChanged)) return null

            const sess = getSession(identity.userOrgId)
            const suggestionId = sess.touch()
            const now = Date.now()

            // Build a single appended transaction representing all the
            // mark/restore work. Tag it with the plugin key so we don't
            // recurse on it.
            const out = newState.tr
            out.setMeta(PLUGIN_KEY, true)
            const ctx: StepContext = {
                out,
                insertMarkType: newState.schema.marks.suggestedInsert,
                deleteMarkType: newState.schema.marks.suggestedDelete,
                formatChangeMarkType: newState.schema.marks.suggestedFormatChange,
                suggestionId,
                authorId: identity.userOrgId,
                now,
            }

            let stepHadEffect = false
            for (const tr of transactions) {
                if (processTransaction(ctx, tr, oldState, newState)) {
                    stepHadEffect = true
                }
            }

            if (!stepHadEffect && out.steps.length === 0) {
                return null
            }

            // Ensure the suggestions map entry exists. Idempotent —
            // SuggestionsMap.create skips known ids. We write outside
            // the PM transaction because PM doesn't know about Y.Map
            // writes; y-prosemirror brackets the whole appendTransaction
            // emit into a single Yjs transaction, so the Map.set still
            // commits atomically with the PM steps.
            suggestionsMap.create({
                id: suggestionId,
                authorId: identity.userOrgId,
                createdAt: now,
            })

            return out
        },
    })
}

// processTransaction handles one user transaction's worth of steps:
// table-change → block-change → format-change → text insert/delete/
// replace fan-out. Returns true iff at least one step produced
// observable work that should keep the appended transaction alive.
// Pulled out of appendTransaction to keep cognitive complexity under
// biome's noExcessiveCognitiveComplexity threshold.
function processTransaction(
    ctx: StepContext,
    tr: Transaction,
    oldState: EditorState,
    newState: EditorState
): boolean {
    let hadEffect = false

    // Phase 5 (Task 13): table-cell-level changes (addRowAfter /
    // deleteRow / deleteColumn / setCellAttribute / merge / split)
    // take ABSOLUTE precedence. Table operations emit multi-step
    // transactions (a row insert + adjacent rowspan adjustments; a
    // row delete + adjacent rowspan adjustments) that the block-
    // change and text-delete branches would mis-classify. By
    // detecting tables first and marking their step indices
    // consumed, those subsequent branches see only non-table steps.
    const table = applyTableChangeStep(ctx, tr, oldState, newState)
    if (table.hadEffect) hadEffect = true

    // Phase 5: block-level changes (setBlockType, setNodeAttribute,
    // block delete) — for the non-table block nodes (paragraph,
    // heading, listItem, blockquote). Cells are excluded from
    // block-change-utils's TARGET_BLOCK_TYPES, so a table row delete
    // here would only match if a paragraph inside a cell were also
    // fully deleted (it's not — text-delete fires for inner text).
    const block = applyBlockChangeStep(ctx, tr, oldState, newState.schema)
    if (block.hadEffect) hadEffect = true

    // Phase 5: detect format changes (toggleBold / toggleItalic / link
    // / textColor / …) next. A single user command may emit multiple
    // AddMark/RemoveMark steps; the helper collapses them into one
    // suggestedFormatChange spanning the merged range.
    if (applyFormatChangeStep(ctx, tr, oldState, newState)) hadEffect = true

    // Union the table + block consumed-step sets so the regular
    // ReplaceStep dispatch skips both branches' consumed indices.
    const consumed = new Set<number>([...table.consumedSteps, ...block.consumedReplaceSteps])
    if (processReplaceSteps(ctx, tr, consumed)) hadEffect = true
    return hadEffect
}

// processReplaceSteps walks the transaction's ReplaceSteps and routes
// each to the appropriate handler (insert / delete / replace). The
// block branch's consumedReplaceSteps set is honored: a step already
// handled as a block delete is not double-counted here.
function processReplaceSteps(ctx: StepContext, tr: Transaction, consumed: Set<number>): boolean {
    let hadEffect = false
    for (let i = 0; i < tr.steps.length; i++) {
        if (consumed.has(i)) continue
        const step = tr.steps[i]
        if (!(step instanceof ReplaceStep)) continue
        const { from, to, slice } = step
        const sliceSize = slice.content.size
        const isInsert = from === to && sliceSize > 0
        const isDelete = from !== to && sliceSize === 0
        const isReplace = from !== to && sliceSize > 0

        if (isInsert) {
            applyInsertStep(ctx, from, slice)
            hadEffect = true
        } else if (isDelete) {
            if (applyDeleteStep(ctx, tr, i, from, to)) hadEffect = true
        } else if (isReplace) {
            applyReplaceStep(ctx, tr, i, from, to, sliceSize)
            hadEffect = true
        }
    }
    return hadEffect
}

// SuggestionCommandLayer is the TipTap extension wrapper that mounts
// the plugin into the editor. The extension is always loaded; the
// plugin internally short-circuits when the mode store reports
// anything other than 'suggesting', so toggling modes doesn't require
// remounting or reconfiguring the editor.
export const SuggestionCommandLayer = Extension.create<SuggestionCommandLayerOptions>({
    name: 'suggestionCommandLayer',

    addOptions() {
        // Defaults aren't usable in production — the editor mount
        // must pass real modeStore + yDoc. Returning empty placeholders
        // avoids a crash if a tooling context (schema-only typecheck,
        // a `getSchema([SuggestionCommandLayer])` call without
        // configure) loads the extension without configuring it.
        return {
            modeStore: null as unknown as EditorModeStore,
            yDoc: null as unknown as Y.Doc,
        }
    },

    addProseMirrorPlugins() {
        const { modeStore, yDoc } = this.options
        if (!modeStore || !yDoc) return []
        return [createSuggestionCommandPlugin({ modeStore, yDoc })]
    },
})
