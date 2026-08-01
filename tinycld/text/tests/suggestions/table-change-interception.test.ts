// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { Table } from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { buildSuggestionEditorExtensions } from '~/tinycld/text/lib/suggestions/build-extensions'
import { SuggestionsMap } from '~/tinycld/text/lib/suggestions/suggestions-map'
import {
    createEditorModeStore,
    EDITOR_MODE_EDITING,
    EDITOR_MODE_SUGGESTING,
} from '~/tinycld/text/stores/editor-mode-store'

// Phase 5 Task 13 integration: when the user is in suggesting mode and
// runs a table command (addRowAfter / addColumnAfter / deleteRow /
// deleteColumn / setCellAttribute / merge / split), the command layer
// must intercept the multi-step transaction and replace per-cell
// effects with per-cell suggestedBlockChange node attributes. The
// visible doc must not show the structural change as if accepted —
// row deletes preserve the row (cells marked deleted), attribute
// changes preserve the original attrs (with the proposal attached).

interface BlockChangePayload {
    suggestionId: string
    authorId: string
    ts: number
    before: { type: string; attrs: Record<string, unknown>; added?: boolean }
    after: { type: string; attrs: Record<string, unknown>; deleted?: boolean }
}

const TABLE_DOC = {
    type: 'doc',
    content: [
        {
            type: 'table',
            content: [
                {
                    type: 'tableRow',
                    content: [
                        {
                            type: 'tableCell',
                            attrs: { colspan: 1, rowspan: 1, colwidth: null },
                            content: [
                                { type: 'paragraph', content: [{ type: 'text', text: 'a1' }] },
                            ],
                        },
                        {
                            type: 'tableCell',
                            attrs: { colspan: 1, rowspan: 1, colwidth: null },
                            content: [
                                { type: 'paragraph', content: [{ type: 'text', text: 'a2' }] },
                            ],
                        },
                        {
                            type: 'tableCell',
                            attrs: { colspan: 1, rowspan: 1, colwidth: null },
                            content: [
                                { type: 'paragraph', content: [{ type: 'text', text: 'a3' }] },
                            ],
                        },
                    ],
                },
                {
                    type: 'tableRow',
                    content: [
                        {
                            type: 'tableCell',
                            attrs: { colspan: 1, rowspan: 1, colwidth: null },
                            content: [
                                { type: 'paragraph', content: [{ type: 'text', text: 'b1' }] },
                            ],
                        },
                        {
                            type: 'tableCell',
                            attrs: { colspan: 1, rowspan: 1, colwidth: null },
                            content: [
                                { type: 'paragraph', content: [{ type: 'text', text: 'b2' }] },
                            ],
                        },
                        {
                            type: 'tableCell',
                            attrs: { colspan: 1, rowspan: 1, colwidth: null },
                            content: [
                                { type: 'paragraph', content: [{ type: 'text', text: 'b3' }] },
                            ],
                        },
                    ],
                },
            ],
        },
    ],
}

function setupEditor(
    opts: {
        mode?: typeof EDITOR_MODE_SUGGESTING | typeof EDITOR_MODE_EDITING
        authorId?: string
    } = {}
) {
    const modeStore = createEditorModeStore()
    modeStore.getState().setIdentity({ userId: opts.authorId ?? 'uo_alice' })
    modeStore.getState().setMode(opts.mode ?? EDITOR_MODE_SUGGESTING)
    const yDoc = new Y.Doc()
    const editor = new Editor({
        extensions: [
            StarterKit,
            Table.configure({ resizable: false }),
            TableRow,
            TableCell,
            TableHeader,
            ...buildSuggestionEditorExtensions({ modeStore, yDoc }),
        ],
        content: TABLE_DOC,
    })
    return { editor, yDoc, modeStore }
}

function collectCellPayloads(editor: Editor): Array<{
    pos: number
    cellType: 'tableCell' | 'tableHeader'
    payload: BlockChangePayload
}> {
    const out: Array<{
        pos: number
        cellType: 'tableCell' | 'tableHeader'
        payload: BlockChangePayload
    }> = []
    editor.state.doc.descendants((node, pos) => {
        if (node.type.name !== 'tableCell' && node.type.name !== 'tableHeader') return true
        const v = node.attrs.suggestedBlockChange as BlockChangePayload | null
        if (v) {
            out.push({
                pos,
                cellType: node.type.name as 'tableCell' | 'tableHeader',
                payload: v,
            })
        }
        return false
    })
    return out
}

function findCellPositionsInDoc(editor: Editor): number[] {
    const positions: number[] = []
    editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
            positions.push(pos)
            return false
        }
        return true
    })
    return positions
}

describe('Phase 5 table-change interception', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0))
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('addRowAfter in suggesting mode stamps each new cell with before.added=true', () => {
        const { editor, yDoc } = setupEditor()
        const cellPositions = findCellPositionsInDoc(editor)
        // Cursor inside row A's first cell.
        editor.commands.setTextSelection(cellPositions[0] + 2)
        editor.commands.addRowAfter()

        const payloads = collectCellPayloads(editor)
        // Only the new cells (3) carry the wrapper attribute — the
        // pre-existing cells are unaffected.
        expect(payloads).toHaveLength(3)
        for (const p of payloads) {
            expect(p.payload.before.added).toBe(true)
            expect(p.payload.after.deleted).toBeFalsy()
            expect(p.payload.authorId).toBe('uo_alice')
            expect(p.cellType).toBe('tableCell')
        }
        // Same suggestionId across the added cells (session grouping).
        const ids = new Set(payloads.map(p => p.payload.suggestionId))
        expect(ids.size).toBe(1)
        // The table now has 3 rows (2 originals + 1 new).
        const tableNode = editor.state.doc.firstChild
        expect(tableNode?.childCount).toBe(3)
        // SuggestionsMap entry created for resolver lookup.
        const map = new SuggestionsMap(yDoc)
        const id = Array.from(ids)[0] as string
        expect(map.get(id)?.authorId).toBe('uo_alice')
        editor.destroy()
    })

    it('deleteRow in suggesting mode keeps cells and marks them after.deleted=true', () => {
        const { editor } = setupEditor()
        const cellPositions = findCellPositionsInDoc(editor)
        // Cursor inside row B's first cell. deleteRow removes row B.
        editor.commands.setTextSelection(cellPositions[3] + 2)
        editor.commands.deleteRow()

        // The table still has 2 rows (the delete was undone + tracked).
        const tableNode = editor.state.doc.firstChild
        expect(tableNode?.childCount).toBe(2)

        // All 3 cells of row B carry the wrapper with deleted=true.
        const payloads = collectCellPayloads(editor)
        expect(payloads).toHaveLength(3)
        for (const p of payloads) {
            expect(p.payload.after.deleted).toBe(true)
            expect(p.payload.before.added).toBeFalsy()
            expect(p.payload.before.type).toBe('tableCell')
        }
        // Same suggestionId across the deleted cells.
        const ids = new Set(payloads.map(p => p.payload.suggestionId))
        expect(ids.size).toBe(1)
        const id = Array.from(ids)[0] as string

        // The restored inline text carries suggestedDelete marks so the
        // strikethrough decoration applies.
        let foundDeleteMark = false
        editor.state.doc.descendants(node => {
            if (!node.isText) return true
            for (const m of node.marks) {
                if (m.type.name === 'suggestedDelete' && m.attrs.suggestionId === id) {
                    foundDeleteMark = true
                }
            }
            return true
        })
        expect(foundDeleteMark).toBe(true)
        editor.destroy()
    })

    it('setCellAttribute in suggesting mode preserves the cell attr and stamps the wrapper', () => {
        const { editor } = setupEditor()
        const cellPositions = findCellPositionsInDoc(editor)
        // Cursor in cell a1; propose colspan=2.
        editor.commands.setTextSelection(cellPositions[0] + 2)
        editor.commands.setCellAttribute('colspan', 2)

        // Cell still has its original colspan=1.
        const cellNode = editor.state.doc.nodeAt(cellPositions[0])
        expect(cellNode?.attrs.colspan).toBe(1)

        // The cell carries a suggestedBlockChange with before.colspan=1,
        // after.colspan=2.
        const payloads = collectCellPayloads(editor)
        expect(payloads).toHaveLength(1)
        const p = payloads[0]
        expect(p.payload.before.attrs.colspan).toBe(1)
        expect(p.payload.after.attrs.colspan).toBe(2)
        expect(p.payload.before.added).toBeFalsy()
        expect(p.payload.after.deleted).toBeFalsy()
        editor.destroy()
    })

    it('deleteColumn in suggesting mode preserves cells across rows and marks them deleted', () => {
        const { editor } = setupEditor()
        const cellPositions = findCellPositionsInDoc(editor)
        // Cursor in cell a2 (middle column of row A).
        editor.commands.setTextSelection(cellPositions[1] + 2)
        editor.commands.deleteColumn()

        // The table still has 2 rows, each with 3 cells (the column
        // delete was undone + tracked).
        const tableNode = editor.state.doc.firstChild
        expect(tableNode?.childCount).toBe(2)
        let cellCount = 0
        editor.state.doc.descendants(node => {
            if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
                cellCount += 1
                return false
            }
            return true
        })
        expect(cellCount).toBe(6)

        // 2 cells carry the wrapper with deleted=true (one per row in
        // the deleted column).
        const payloads = collectCellPayloads(editor)
        expect(payloads).toHaveLength(2)
        for (const p of payloads) {
            expect(p.payload.after.deleted).toBe(true)
        }
        editor.destroy()
    })

    it('table commands in editing mode apply directly with no wrapper attribute', () => {
        const { editor } = setupEditor({ mode: EDITOR_MODE_EDITING })
        const cellPositions = findCellPositionsInDoc(editor)
        editor.commands.setTextSelection(cellPositions[0] + 2)
        editor.commands.addRowAfter()

        // The table grew to 3 rows.
        const tableNode = editor.state.doc.firstChild
        expect(tableNode?.childCount).toBe(3)
        // No suggestedBlockChange entries anywhere — editing mode means
        // the user's structural change applied directly.
        expect(collectCellPayloads(editor)).toHaveLength(0)
        editor.destroy()
    })

    it('addRow then setCellAttribute within session window share one suggestionId', () => {
        const { editor } = setupEditor()
        const cellPositions = findCellPositionsInDoc(editor)
        editor.commands.setTextSelection(cellPositions[0] + 2)
        editor.commands.addRowAfter()

        // Stay inside the 30s session window.
        vi.advanceTimersByTime(200)

        // Now propose a cell-attr change on cell a2.
        const cellPositionsNow = findCellPositionsInDoc(editor)
        // After addRowAfter, the table has 3 rows. Row A's cells are
        // still at the same positions as before (they precede the new
        // row in the doc).
        editor.commands.setTextSelection(cellPositionsNow[1] + 2)
        editor.commands.setCellAttribute('colspan', 2)

        const payloads = collectCellPayloads(editor)
        // 3 added cells + 1 attr-changed cell = 4 entries.
        expect(payloads).toHaveLength(4)
        const ids = new Set(payloads.map(p => p.payload.suggestionId))
        // All four share the same suggestionId — session grouping.
        expect(ids.size).toBe(1)
        editor.destroy()
    })
})
