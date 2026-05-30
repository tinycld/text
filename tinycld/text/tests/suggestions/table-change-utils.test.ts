// @vitest-environment happy-dom
import { Editor, getSchema } from '@tiptap/core'
import { Table } from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import StarterKit from '@tiptap/starter-kit'
import { EditorState } from 'prosemirror-state'
import { describe, expect, it } from 'vitest'
import { buildSuggestionEditorExtensions } from '~/tinycld/text/lib/suggestions/build-extensions'
import {
    extractTableChanges,
    hasTableChanges,
    type TableChange,
} from '~/tinycld/text/lib/suggestions/table-change-utils'

// Build a Tiptap editor with the table extensions and the suggestion
// schema attached. Using a real editor (rather than a hand-rolled
// EditorState) is the simplest way to exercise table operations:
// addRowAfter / deleteRow / deleteColumn / setCellAttribute are
// commands defined by the Tiptap table extension, and they need a
// full editor's command machinery to dispatch correctly.
function buildEditorWithTable() {
    const editor = new Editor({
        extensions: [
            StarterKit,
            Table.configure({ resizable: false }),
            TableRow,
            TableCell,
            TableHeader,
            ...buildSuggestionEditorExtensions(),
        ],
        content: {
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
                                        {
                                            type: 'paragraph',
                                            content: [{ type: 'text', text: 'a1' }],
                                        },
                                    ],
                                },
                                {
                                    type: 'tableCell',
                                    attrs: { colspan: 1, rowspan: 1, colwidth: null },
                                    content: [
                                        {
                                            type: 'paragraph',
                                            content: [{ type: 'text', text: 'a2' }],
                                        },
                                    ],
                                },
                                {
                                    type: 'tableCell',
                                    attrs: { colspan: 1, rowspan: 1, colwidth: null },
                                    content: [
                                        {
                                            type: 'paragraph',
                                            content: [{ type: 'text', text: 'a3' }],
                                        },
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
                                        {
                                            type: 'paragraph',
                                            content: [{ type: 'text', text: 'b1' }],
                                        },
                                    ],
                                },
                                {
                                    type: 'tableCell',
                                    attrs: { colspan: 1, rowspan: 1, colwidth: null },
                                    content: [
                                        {
                                            type: 'paragraph',
                                            content: [{ type: 'text', text: 'b2' }],
                                        },
                                    ],
                                },
                                {
                                    type: 'tableCell',
                                    attrs: { colspan: 1, rowspan: 1, colwidth: null },
                                    content: [
                                        {
                                            type: 'paragraph',
                                            content: [{ type: 'text', text: 'b3' }],
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ],
        },
    })
    return editor
}

// findCellPositionsInDoc returns the offsets of every tableCell or
// tableHeader present in the given editor's current doc, in document
// order. Used to position the selection at a known cell before invoking
// a table command, since the command-layer entrypoints rely on
// selection state.
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

// captureNextTransaction monkey-patches the editor's view.dispatch
// to capture the next dispatched Transaction, then restores the
// original dispatch. The captured transaction (and the state it was
// dispatched against) feed extractTableChanges directly.
function captureNextTransaction(editor: Editor, command: () => void) {
    const beforeState = editor.state
    let captured:
        | { state: typeof beforeState; tr: import('@tiptap/pm/state').Transaction }
        | undefined
    const orig = editor.view.dispatch
    editor.view.dispatch = tr => {
        if (!captured) {
            captured = { state: beforeState, tr }
        }
        orig.call(editor.view, tr)
    }
    try {
        command()
    } finally {
        editor.view.dispatch = orig
    }
    return captured
}

describe('extractTableChanges', () => {
    it('addRowAfter on a 3-column table yields 3 cell-added entries', () => {
        const editor = buildEditorWithTable()
        // Place the selection inside the first row's first cell so
        // addRowAfter targets the first row.
        // First cell text content starts inside the cell — the cell
        // itself starts at some offset, +2 (cell open + paragraph open)
        // lands inside the text. cell positions are absolute in the doc.
        const cellPositions = findCellPositionsInDoc(editor)
        // cell[0] is the first cell of the first row.
        const firstCell = cellPositions[0]
        editor.commands.setTextSelection(firstCell + 2)

        const captured = captureNextTransaction(editor, () => {
            editor.commands.addRowAfter()
        })
        expect(captured).toBeDefined()
        if (!captured) throw new Error('not captured')

        const changes = extractTableChanges(captured.tr, captured.state, editor.state)
        const added = changes.filter(c => c.kind === 'cell-added')
        // 3 cells added (one per column in the new row).
        expect(added).toHaveLength(3)
        for (const a of added) {
            expect(a.cellType).toBe('tableCell')
        }
        editor.destroy()
    })

    it('deleteRow on a 3-column row yields 3 cell-deleted entries', () => {
        const editor = buildEditorWithTable()
        // Place selection in row B (the second row) — deleteRow
        // targets the row containing the selection.
        const cellPositions = findCellPositionsInDoc(editor)
        // cells 0..2 = row A; cells 3..5 = row B.
        const rowBFirstCell = cellPositions[3]
        editor.commands.setTextSelection(rowBFirstCell + 2)

        const captured = captureNextTransaction(editor, () => {
            editor.commands.deleteRow()
        })
        if (!captured) throw new Error('not captured')

        const changes = extractTableChanges(captured.tr, captured.state, editor.state)
        const deleted = changes.filter(c => c.kind === 'cell-deleted')
        expect(deleted).toHaveLength(3)
        for (const d of deleted) {
            expect(d.cellType).toBe('tableCell')
        }
        editor.destroy()
    })

    it('deleteColumn yields cell-deleted entries — one per row in the column', () => {
        const editor = buildEditorWithTable()
        // Selection in the middle column (a2).
        const cellPositions = findCellPositionsInDoc(editor)
        const a2Cell = cellPositions[1]
        editor.commands.setTextSelection(a2Cell + 2)

        const captured = captureNextTransaction(editor, () => {
            editor.commands.deleteColumn()
        })
        if (!captured) throw new Error('not captured')

        const changes = extractTableChanges(captured.tr, captured.state, editor.state)
        const deleted = changes.filter(c => c.kind === 'cell-deleted')
        // The table has 2 rows; deleting one column removes 2 cells.
        expect(deleted).toHaveLength(2)
        editor.destroy()
    })

    it('setCellAttribute on a single cell yields one cell-attr entry', () => {
        const editor = buildEditorWithTable()
        // Selection in a1 — setCellAttribute('colspan', 2) on this cell.
        const cellPositions = findCellPositionsInDoc(editor)
        const a1Cell = cellPositions[0]
        editor.commands.setTextSelection(a1Cell + 2)

        const captured = captureNextTransaction(editor, () => {
            editor.commands.setCellAttribute('colspan', 2)
        })
        if (!captured) throw new Error('not captured')

        const changes = extractTableChanges(captured.tr, captured.state, editor.state)
        const attrChanges = changes.filter(c => c.kind === 'cell-attr')
        expect(attrChanges).toHaveLength(1)
        const a = attrChanges[0]
        if (a.kind !== 'cell-attr') throw new Error('narrow')
        expect(a.cellType).toBe('tableCell')
        expect(a.beforeAttrs.colspan).toBe(1)
        expect(a.afterAttrs.colspan).toBe(2)
        editor.destroy()
    })

    it('plain text edit inside a cell yields no table changes', () => {
        const editor = buildEditorWithTable()
        // Cursor inside cell a1's text node.
        const cellPositions = findCellPositionsInDoc(editor)
        const a1Cell = cellPositions[0]
        editor.commands.setTextSelection(a1Cell + 2)

        const captured = captureNextTransaction(editor, () => {
            editor.commands.insertContent('X')
        })
        if (!captured) throw new Error('not captured')

        const changes = extractTableChanges(captured.tr, captured.state, editor.state)
        // Text changes inside a cell are not table-level changes.
        expect(changes).toEqual([])
        editor.destroy()
    })

    it('returns an empty array for a transaction with no table-affecting steps', () => {
        const schema = getSchema([StarterKit, ...buildSuggestionEditorExtensions()])
        const doc = schema.nodes.doc.create(
            {},
            schema.nodes.paragraph.create({}, schema.text('hello'))
        )
        const state = EditorState.create({ doc, schema })
        const tr = state.tr.insertText('!', 6)
        const changes = extractTableChanges(tr, state, state.apply(tr))
        expect(changes).toEqual([])
    })
})

describe('hasTableChanges', () => {
    it('returns true when the transaction inserts cells', () => {
        const editor = buildEditorWithTable()
        const cellPositions = findCellPositionsInDoc(editor)
        editor.commands.setTextSelection(cellPositions[0] + 2)
        const captured = captureNextTransaction(editor, () => {
            editor.commands.addRowAfter()
        })
        if (!captured) throw new Error('not captured')
        expect(hasTableChanges(captured.tr, captured.state)).toBe(true)
        editor.destroy()
    })

    it('returns true when the transaction deletes cells', () => {
        const editor = buildEditorWithTable()
        const cellPositions = findCellPositionsInDoc(editor)
        editor.commands.setTextSelection(cellPositions[3] + 2)
        const captured = captureNextTransaction(editor, () => {
            editor.commands.deleteRow()
        })
        if (!captured) throw new Error('not captured')
        expect(hasTableChanges(captured.tr, captured.state)).toBe(true)
        editor.destroy()
    })

    it('returns true when the transaction sets cell attributes', () => {
        const editor = buildEditorWithTable()
        const cellPositions = findCellPositionsInDoc(editor)
        editor.commands.setTextSelection(cellPositions[0] + 2)
        const captured = captureNextTransaction(editor, () => {
            editor.commands.setCellAttribute('colspan', 2)
        })
        if (!captured) throw new Error('not captured')
        expect(hasTableChanges(captured.tr, captured.state)).toBe(true)
        editor.destroy()
    })

    it('returns false for a text-only edit inside a cell', () => {
        const editor = buildEditorWithTable()
        const cellPositions = findCellPositionsInDoc(editor)
        editor.commands.setTextSelection(cellPositions[0] + 2)
        const captured = captureNextTransaction(editor, () => {
            editor.commands.insertContent('X')
        })
        if (!captured) throw new Error('not captured')
        expect(hasTableChanges(captured.tr, captured.state)).toBe(false)
        editor.destroy()
    })
})

// Type-level pin: TableChange is the exported union the command-layer
// consumes. If the union shape changes (e.g. a new sub-case is added),
// this assignment forces a compile-time review of all consumers.
describe('TableChange union', () => {
    it('typechecks the discriminated union', () => {
        const cases: TableChange[] = []
        expect(cases.length).toBe(0)
    })
})
