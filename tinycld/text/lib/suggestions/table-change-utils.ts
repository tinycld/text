import type { Node as PMNode } from '@tiptap/pm/model'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { ReplaceAroundStep, ReplaceStep } from '@tiptap/pm/transform'

// A TableChange is one detected cell-level transformation produced by a
// table operation (addRow/addColumn/deleteRow/deleteColumn/setCellAttr/
// merge/split). The command-layer rewrites these into per-cell
// suggestedBlockChange node attributes when in suggesting mode.
//
// Why this is its own module (not folded into block-change-utils):
//   - The detection rules are fundamentally different. Block changes
//     fire on AttrStep / ReplaceAroundStep / whole-block-delete; table
//     operations emit complex multi-step transactions (tr.insert of a
//     row containing N cells, tr.delete of a row range, possibly with
//     adjacent cells getting setNodeMarkup'd to update rowspan).
//   - "Added" cells need a distinct payload shape. An added cell didn't
//     exist before the suggestion, so its `before` makes no sense as a
//     pre-existing type/attrs snapshot. We mark it with `before.added`.
//
// All positions in returned TableChange entries are anchored as follows:
//   - cell-added: position in the NEW (post-transaction) doc.
//   - cell-deleted: position in the OLD (pre-transaction) doc.
//   - cell-attr: position in the OLD doc; the command-layer maps this
//     through its own appended transaction's mapping.
export type TableChange =
    | {
          kind: 'cell-added'
          // Position in the NEW doc where the new cell now lives.
          pos: number
          cellType: 'tableCell' | 'tableHeader'
          cellNode: PMNode
      }
    | {
          kind: 'cell-deleted'
          // Position in the OLD doc where the deleted cell was.
          pos: number
          cellType: 'tableCell' | 'tableHeader'
          cellNode: PMNode
      }
    | {
          kind: 'cell-attr'
          // Position in the OLD doc; the command-layer's emitted
          // transaction maps this through its own mapping before stamping.
          pos: number
          cellType: 'tableCell' | 'tableHeader'
          beforeAttrs: Record<string, unknown>
          afterAttrs: Record<string, unknown>
      }

// Cell node-type names the detector recognizes. Mirrors the table
// extension's tableCell + tableHeader.
const CELL_TYPES = new Set(['tableCell', 'tableHeader'])

function isCellType(name: string): name is 'tableCell' | 'tableHeader' {
    return CELL_TYPES.has(name)
}

// Drop the suggestion-tracking attribute from a cell's attrs before
// recording them in a TableChange payload. The before/after shapes
// record user-facing attrs only; including suggestedBlockChange would
// round-trip our own state into the payload and corrupt resolve.
function stripTrackingAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const key in attrs) {
        if (key === 'suggestedBlockChange') continue
        out[key] = attrs[key]
    }
    return out
}

// Walk a slice's content tree and collect every cell node found inside
// it (relative offset + node). Used when an insert slice or
// ReplaceAroundStep slice contains a tableRow with N cells: each cell
// becomes a cell-added entry.
//
// The offset is relative to the slice's content start; the caller adds
// the post-step insertion position to get the final new-doc pos.
function findCellsInSlice(
    slice: { content: { descendants: (fn: (n: PMNode, p: number) => boolean | void) => void } }
): Array<{ relPos: number; node: PMNode }> {
    const out: Array<{ relPos: number; node: PMNode }> = []
    slice.content.descendants((node, relPos) => {
        if (isCellType(node.type.name)) {
            out.push({ relPos, node })
            // Don't descend into a cell — its inner content (paragraphs,
            // text) isn't relevant to TableChange detection.
            return false
        }
        return true
    })
    return out
}

// Walk an old-doc range and collect every cell node fully enclosed in
// it. Used when a ReplaceStep deletes a tableRow with N cells: each
// fully-contained cell becomes a cell-deleted entry.
function findCellsInRange(
    doc: PMNode,
    from: number,
    to: number
): Array<{ pos: number; node: PMNode }> {
    const out: Array<{ pos: number; node: PMNode }> = []
    doc.nodesBetween(from, to, (node, nodePos) => {
        if (!isCellType(node.type.name)) return true
        const startsInside = nodePos >= from
        const endsInside = nodePos + node.nodeSize <= to
        if (startsInside && endsInside) {
            out.push({ pos: nodePos, node })
            // Don't descend — the cell's children (paragraphs, text)
            // aren't cell-level changes.
            return false
        }
        return true
    })
    return out
}

function handleReplaceStep(
    step: ReplaceStep,
    originalState: EditorState,
    tr: Transaction,
    stepIndex: number,
    byKey: Map<string, TableChange>
): void {
    const sliceSize = step.slice.content.size

    // Phase 1 — deleted cells: any cell in the pre-step doc fully
    // enclosed in [from, to) is a deletion candidate. We snapshot
    // tr.docs[stepIndex] (the doc as it existed *before* this step
    // was applied) rather than originalState.doc because earlier
    // steps in the same transaction may have shifted positions.
    const preStepDoc = tr.docs[stepIndex] ?? originalState.doc
    const deletedCells = findCellsInRange(preStepDoc, step.from, step.to)
    for (const { pos, node } of deletedCells) {
        const cellType = node.type.name
        if (!isCellType(cellType)) continue
        byKey.set(`del:${pos}`, {
            kind: 'cell-deleted',
            pos,
            cellType,
            cellNode: node,
        })
    }

    // Phase 2 — added cells: any cell in the slice's content becomes a
    // cell-added entry. The new-doc position is step.from (where the
    // slice was inserted) plus the cell's relative offset inside the
    // slice's content. (For a tr.insert(pos, row) call the slice has
    // openStart=0 and openEnd=0, so this offset arithmetic is exact.)
    if (sliceSize > 0) {
        const addedCells = findCellsInSlice(step.slice)
        for (const { relPos, node } of addedCells) {
            const cellType = node.type.name
            if (!isCellType(cellType)) continue
            const newPos = step.from + relPos
            byKey.set(`add:${newPos}`, {
                kind: 'cell-added',
                pos: newPos,
                cellType,
                cellNode: node,
            })
        }
    }
}

function handleReplaceAroundStep(
    step: ReplaceAroundStep,
    originalState: EditorState,
    tr: Transaction,
    stepIndex: number,
    byKey: Map<string, TableChange>
): void {
    // setCellAttr emits a ReplaceAroundStep targeting a single cell:
    // the step wraps the cell's inner content with a new opening token
    // carrying the new attrs. step.from is the cell's position in the
    // pre-step doc; step.slice.content.firstChild is the new cell.
    const preStepDoc = tr.docs[stepIndex] ?? originalState.doc
    const oldCell = preStepDoc.nodeAt(step.from)
    if (!oldCell || !isCellType(oldCell.type.name)) {
        // Not a cell-level ReplaceAroundStep. Could still be a row-
        // wrapping operation that contains cells in its slice — fall
        // through to the slice-walk below to catch any added cells.
        const addedCells = findCellsInSlice(step.slice)
        for (const { relPos, node } of addedCells) {
            const cellType = node.type.name
            if (!isCellType(cellType)) continue
            const newPos = step.from + relPos
            byKey.set(`add:${newPos}`, {
                kind: 'cell-added',
                pos: newPos,
                cellType,
                cellNode: node,
            })
        }
        return
    }
    const newCell = step.slice.content.firstChild
    if (!newCell || !isCellType(newCell.type.name)) return
    // Same-type attr swap on a single cell.
    if (newCell.type.name === oldCell.type.name) {
        const beforeAttrs = stripTrackingAttrs(oldCell.attrs)
        const afterAttrs = stripTrackingAttrs(newCell.attrs)
        // Skip no-op: every key in before matches the corresponding
        // key in after. PM's setNodeMarkup with identical attrs is
        // legal (and prosemirror-tables' setCellAttr guards against
        // that case before dispatch), but defensive symmetry.
        if (JSON.stringify(beforeAttrs) === JSON.stringify(afterAttrs)) return
        const cellType = oldCell.type.name
        if (!isCellType(cellType)) return
        byKey.set(`attr:${step.from}`, {
            kind: 'cell-attr',
            pos: step.from,
            cellType,
            beforeAttrs,
            afterAttrs,
        })
    }
}

// extractTableChanges walks a user transaction's steps and returns one
// TableChange entry per affected cell. Table operations (addRow,
// addColumn, deleteRow, deleteColumn, setCellAttr, merge/split) emit
// complex multi-step transactions; this helper fans them out into
// per-cell entries the command-layer can rewrite into
// suggestedBlockChange attributes.
//
// Detection strategy:
//   - ReplaceStep (delete-only): every cell fully enclosed in the
//     deleted range → cell-deleted. The original cells are read from
//     tr.docs[stepIndex] so prior steps in the same transaction don't
//     skew positions.
//   - ReplaceStep (insert or replace): every cell inside the slice's
//     content → cell-added at step.from + relative-offset. Combined
//     with the delete-walk above, this captures replace-style
//     transactions cleanly.
//   - ReplaceAroundStep on a cell-typed node: when the slice's first
//     child is the same cell type with different attrs → cell-attr.
//     When the wrapped node isn't a cell (e.g. a row-level wrap), the
//     slice is still walked for any added cells inside it.
//
// Text-only edits inside a cell (typing, deleting characters) are
// IGNORED — those flow through the existing insert/delete paths in the
// command layer. Block-level changes inside a cell (e.g. changing a
// paragraph in a cell to a heading) are picked up by extractBlockChanges
// — they're independent of the table change detection.
//
// Returned entries are deduped by (kind, pos) so a no-op multi-step
// transaction doesn't produce duplicate entries.
export function extractTableChanges(
    tr: Transaction,
    originalState: EditorState,
    _newState: EditorState
): TableChange[] {
    // Collect by composite key so duplicate steps at the same position
    // collapse into one entry. Sorted by pos at the end so callers can
    // iterate predictably.
    const byKey = new Map<string, TableChange>()

    for (let i = 0; i < tr.steps.length; i++) {
        const step = tr.steps[i]
        if (step instanceof ReplaceStep) {
            handleReplaceStep(step, originalState, tr, i, byKey)
        } else if (step instanceof ReplaceAroundStep) {
            handleReplaceAroundStep(step, originalState, tr, i, byKey)
        }
        // AttrStep can't target a cell attribute directly through PM
        // (tables use setNodeMarkup, which emits ReplaceAroundStep);
        // skipping it here avoids interfering with block-change-utils
        // which owns AttrStep handling.
    }

    return Array.from(byKey.values()).sort((a, b) => a.pos - b.pos)
}

// hasTableChanges is a cheap predicate the command-layer uses to
// decide whether to take the table-change branch. Returns true iff
// extractTableChanges would emit at least one entry — without
// materializing the full list.
export function hasTableChanges(tr: Transaction, originalState: EditorState): boolean {
    for (let i = 0; i < tr.steps.length; i++) {
        const step = tr.steps[i]
        if (step instanceof ReplaceStep) {
            const sliceSize = step.slice.content.size
            const preStepDoc = tr.docs[i] ?? originalState.doc
            // A deleted-cell predicate: any cell fully enclosed in
            // [from, to)?
            let found = false
            preStepDoc.nodesBetween(step.from, step.to, (node, nodePos) => {
                if (found) return false
                if (!isCellType(node.type.name)) return true
                if (nodePos >= step.from && nodePos + node.nodeSize <= step.to) {
                    found = true
                    return false
                }
                return true
            })
            if (found) return true
            // An added-cell predicate: any cell inside the slice?
            if (sliceSize > 0) {
                let foundInSlice = false
                step.slice.content.descendants(node => {
                    if (foundInSlice) return false
                    if (isCellType(node.type.name)) {
                        foundInSlice = true
                        return false
                    }
                    return true
                })
                if (foundInSlice) return true
            }
        } else if (step instanceof ReplaceAroundStep) {
            const preStepDoc = tr.docs[i] ?? originalState.doc
            const oldCell = preStepDoc.nodeAt(step.from)
            if (oldCell && isCellType(oldCell.type.name)) {
                const newCell = step.slice.content.firstChild
                if (newCell && isCellType(newCell.type.name)) {
                    return true
                }
            }
            // Also catch cells appearing inside the slice.
            let foundInSlice = false
            step.slice.content.descendants(node => {
                if (foundInSlice) return false
                if (isCellType(node.type.name)) {
                    foundInSlice = true
                    return false
                }
                return true
            })
            if (foundInSlice) return true
        }
    }
    return false
}
