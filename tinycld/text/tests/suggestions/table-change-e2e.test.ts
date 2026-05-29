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
import { acceptSuggestion, rejectSuggestion } from '~/tinycld/text/lib/suggestions/resolve'
import {
    createEditorModeStore,
    EDITOR_MODE_EDITING,
    EDITOR_MODE_SUGGESTING,
} from '~/tinycld/text/stores/editor-mode-store'

// Phase 5 Task 14 — full TipTap editor under suggesting mode
// exercising the table-change pipeline end to end. Each test:
//   1. Builds a suggesting-mode editor with a small 2x3 table.
//   2. Runs a table command (addRowAfter / deleteRow / setCellAttribute).
//   3. Asserts the doc shape after interception (visible structure
//      unchanged or restored; suggestedBlockChange attributes carry
//      the proposal).
//   4. Resolves (accept or reject) and asserts the post-resolution
//      shape: row gone, row stays, attribute applied, etc.

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
    modeStore.getState().setIdentity({ userOrgId: opts.authorId ?? 'uo_alice' })
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

function findCellPositions(editor: Editor): number[] {
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

function findCellPayloads(editor: Editor): Array<{ pos: number; payload: BlockChangePayload }> {
    const out: Array<{ pos: number; payload: BlockChangePayload }> = []
    editor.state.doc.descendants((node, pos) => {
        if (node.type.name !== 'tableCell' && node.type.name !== 'tableHeader') return true
        const v = node.attrs.suggestedBlockChange as BlockChangePayload | null
        if (v) out.push({ pos, payload: v })
        return false
    })
    return out
}

function countCells(editor: Editor): number {
    let count = 0
    editor.state.doc.descendants(node => {
        if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
            count += 1
            return false
        }
        return true
    })
    return count
}

function rowTextSummary(editor: Editor): string[] {
    const out: string[] = []
    editor.state.doc.descendants(node => {
        if (node.type.name === 'tableRow') {
            out.push(node.textContent)
            return false
        }
        return true
    })
    return out
}

describe('Phase 5 table-change end-to-end', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0))
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('Test 1: addRowAfter in suggesting mode → reject → row gone', () => {
        const { editor, yDoc, modeStore } = setupEditor()
        const cellPositions = findCellPositions(editor)
        editor.commands.setTextSelection(cellPositions[0] + 2)
        editor.commands.addRowAfter()

        // 3 added cells in a new row.
        const payloads = findCellPayloads(editor)
        expect(payloads).toHaveLength(3)
        // The table grew from 2 rows to 3.
        expect(editor.state.doc.firstChild?.childCount).toBe(3)
        const id = payloads[0].payload.suggestionId

        // Reject: row disappears, table back to 2 rows.
        modeStore.getState().setMode(EDITOR_MODE_EDITING)
        rejectSuggestion(editor, id, { resolverUserOrgId: 'uo_carol', yDoc })

        expect(editor.state.doc.firstChild?.childCount).toBe(2)
        expect(countCells(editor)).toBe(6)
        // No suggestedBlockChange wrappers remain.
        expect(findCellPayloads(editor)).toHaveLength(0)
        editor.destroy()
    })

    it('Test 2: addRowAfter in suggesting mode → accept → row stays', () => {
        const { editor, yDoc, modeStore } = setupEditor()
        const cellPositions = findCellPositions(editor)
        editor.commands.setTextSelection(cellPositions[0] + 2)
        editor.commands.addRowAfter()

        const payloads = findCellPayloads(editor)
        const id = payloads[0].payload.suggestionId

        // Accept: row stays with 3 cells; the wrapper attribute is gone.
        modeStore.getState().setMode(EDITOR_MODE_EDITING)
        acceptSuggestion(editor, id, { resolverUserOrgId: 'uo_carol', yDoc })

        expect(editor.state.doc.firstChild?.childCount).toBe(3)
        expect(countCells(editor)).toBe(9)
        expect(findCellPayloads(editor)).toHaveLength(0)
        editor.destroy()
    })

    it('Test 3: deleteRow in suggesting mode → reject → row stays', () => {
        const { editor, yDoc, modeStore } = setupEditor()
        const cellPositions = findCellPositions(editor)
        // Cursor in row B's first cell. deleteRow targets row B.
        editor.commands.setTextSelection(cellPositions[3] + 2)
        editor.commands.deleteRow()

        // Both rows still present (delete tracked, not applied).
        expect(editor.state.doc.firstChild?.childCount).toBe(2)
        const payloads = findCellPayloads(editor)
        const id = payloads[0].payload.suggestionId

        // Reject: row stays, suggestedDelete marks gone.
        modeStore.getState().setMode(EDITOR_MODE_EDITING)
        rejectSuggestion(editor, id, { resolverUserOrgId: 'uo_carol', yDoc })

        expect(editor.state.doc.firstChild?.childCount).toBe(2)
        expect(rowTextSummary(editor)).toEqual(['a1a2a3', 'b1b2b3'])
        expect(findCellPayloads(editor)).toHaveLength(0)
        // No suggestedDelete marks remain on the restored cells' text.
        let hasMark = false
        editor.state.doc.descendants(node => {
            if (!node.isText) return true
            for (const m of node.marks) {
                if (m.type.name === 'suggestedDelete') hasMark = true
            }
            return true
        })
        expect(hasMark).toBe(false)
        editor.destroy()
    })

    it('Test 4: deleteRow in suggesting mode → accept → row gone', () => {
        const { editor, yDoc, modeStore } = setupEditor()
        const cellPositions = findCellPositions(editor)
        editor.commands.setTextSelection(cellPositions[3] + 2)
        editor.commands.deleteRow()

        const payloads = findCellPayloads(editor)
        const id = payloads[0].payload.suggestionId

        // Accept: row B is deleted; only row A remains.
        modeStore.getState().setMode(EDITOR_MODE_EDITING)
        acceptSuggestion(editor, id, { resolverUserOrgId: 'uo_carol', yDoc })

        expect(editor.state.doc.firstChild?.childCount).toBe(1)
        expect(rowTextSummary(editor)).toEqual(['a1a2a3'])
        editor.destroy()
    })

    it('Test 5: cell attribute change → accept → attr applied; reject → not', () => {
        // Two passes — accept side first.
        {
            const { editor, yDoc, modeStore } = setupEditor()
            const cellPositions = findCellPositions(editor)
            editor.commands.setTextSelection(cellPositions[0] + 2)
            editor.commands.setCellAttribute('colspan', 2)

            // Visible cell still has colspan=1, proposal records colspan=2.
            expect(editor.state.doc.nodeAt(cellPositions[0])?.attrs.colspan).toBe(1)
            const id = findCellPayloads(editor)[0].payload.suggestionId

            modeStore.getState().setMode(EDITOR_MODE_EDITING)
            acceptSuggestion(editor, id, { resolverUserOrgId: 'uo_carol', yDoc })

            // After accept: colspan applied, wrapper gone.
            const cellAfter = editor.state.doc.nodeAt(cellPositions[0])
            expect(cellAfter?.attrs.colspan).toBe(2)
            expect(cellAfter?.attrs.suggestedBlockChange).toBeFalsy()
            editor.destroy()
        }
        // Reject side.
        {
            const { editor, yDoc, modeStore } = setupEditor()
            const cellPositions = findCellPositions(editor)
            editor.commands.setTextSelection(cellPositions[0] + 2)
            editor.commands.setCellAttribute('colspan', 2)
            const id = findCellPayloads(editor)[0].payload.suggestionId

            modeStore.getState().setMode(EDITOR_MODE_EDITING)
            rejectSuggestion(editor, id, { resolverUserOrgId: 'uo_carol', yDoc })

            // After reject: colspan still 1, wrapper gone.
            const cellAfter = editor.state.doc.nodeAt(cellPositions[0])
            expect(cellAfter?.attrs.colspan).toBe(1)
            expect(cellAfter?.attrs.suggestedBlockChange).toBeFalsy()
            editor.destroy()
        }
    })

    it('Test 6: editing mode applies table commands directly with no suggestion', () => {
        const { editor } = setupEditor({ mode: EDITOR_MODE_EDITING })
        const cellPositions = findCellPositions(editor)
        editor.commands.setTextSelection(cellPositions[0] + 2)
        editor.commands.addRowAfter()

        // The table grew. No suggestion entries.
        expect(editor.state.doc.firstChild?.childCount).toBe(3)
        expect(findCellPayloads(editor)).toHaveLength(0)
        editor.destroy()
    })

    it('Test 7: deleteColumn in suggesting mode → accept → column gone across rows', () => {
        const { editor, yDoc, modeStore } = setupEditor()
        const cellPositions = findCellPositions(editor)
        // Cursor in the middle column (a2).
        editor.commands.setTextSelection(cellPositions[1] + 2)
        editor.commands.deleteColumn()

        const payloads = findCellPayloads(editor)
        // 2 cells marked deleted (one per row in the middle column).
        expect(payloads).toHaveLength(2)
        const id = payloads[0].payload.suggestionId

        modeStore.getState().setMode(EDITOR_MODE_EDITING)
        acceptSuggestion(editor, id, { resolverUserOrgId: 'uo_carol', yDoc })

        // After accept: middle column is gone — each row has 2 cells.
        expect(editor.state.doc.firstChild?.childCount).toBe(2)
        expect(countCells(editor)).toBe(4)
        expect(rowTextSummary(editor)).toEqual(['a1a3', 'b1b3'])
        editor.destroy()
    })

    it('Test 8: deleteColumn in suggesting mode → reject → column stays', () => {
        const { editor, yDoc, modeStore } = setupEditor()
        const cellPositions = findCellPositions(editor)
        editor.commands.setTextSelection(cellPositions[1] + 2)
        editor.commands.deleteColumn()

        const payloads = findCellPayloads(editor)
        const id = payloads[0].payload.suggestionId

        modeStore.getState().setMode(EDITOR_MODE_EDITING)
        rejectSuggestion(editor, id, { resolverUserOrgId: 'uo_carol', yDoc })

        // After reject: column intact, both rows have 3 cells.
        expect(countCells(editor)).toBe(6)
        expect(rowTextSummary(editor)).toEqual(['a1a2a3', 'b1b2b3'])
        editor.destroy()
    })
})
