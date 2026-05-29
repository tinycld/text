// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { Table } from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import StarterKit from '@tiptap/starter-kit'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { computeDocumentSuggestions } from '~/tinycld/text/hooks/use-document-suggestions'
import { buildSuggestionEditorExtensions } from '~/tinycld/text/lib/suggestions/build-extensions'
import { SuggestionsMap } from '~/tinycld/text/lib/suggestions/suggestions-map'

// Phase 5 Task 15 — extend the document-suggestion parser so it
// surfaces format-change marks, block-change attributes (on
// paragraph/heading/etc.), and cell-change attributes (on
// tableCell/tableHeader). Each test renders an editor with one or
// more of those structures and asserts the parser's output shape.

function makeEditor(content: object, includeTables = false) {
    const extensions = includeTables
        ? [
              StarterKit,
              Table.configure({ resizable: false }),
              TableRow,
              TableCell,
              TableHeader,
              ...buildSuggestionEditorExtensions(),
          ]
        : [StarterKit, ...buildSuggestionEditorExtensions()]
    return new Editor({ extensions, content })
}

describe('computeDocumentSuggestions (Phase 5 — format/block/cell change)', () => {
    it('emits a format-change AnchoredSuggestion for a suggestedFormatChange mark', () => {
        const yDoc = new Y.Doc()
        const editor = makeEditor({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        {
                            type: 'text',
                            text: 'styled',
                            marks: [
                                {
                                    type: 'suggestedFormatChange',
                                    attrs: {
                                        suggestionId: 'sfc-1',
                                        authorId: 'uo_alice',
                                        ts: 1000,
                                        before: [],
                                        after: [{ type: 'bold' }],
                                    },
                                },
                            ],
                        },
                    ],
                },
            ],
        })
        const map = new SuggestionsMap(yDoc)
        map.create({ id: 'sfc-1', authorId: 'uo_alice', createdAt: 1000 })

        const result = computeDocumentSuggestions(editor.state.doc, map)
        expect(result.anchored).toHaveLength(1)
        const row = result.anchored[0]
        expect(row.id).toBe('sfc-1')
        expect(row.kind).toBe('format-change')
        expect(row.authorId).toBe('uo_alice')
        expect(row.snippet).toContain('styled')
        expect(row.beforeMarks).toEqual([])
        expect(row.afterMarks).toEqual([{ type: 'bold' }])
        editor.destroy()
    })

    it('emits a block-change AnchoredSuggestion for a paragraph carrying suggestedBlockChange', () => {
        const yDoc = new Y.Doc()
        const editor = makeEditor({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    attrs: {
                        suggestedBlockChange: {
                            suggestionId: 'sbc-1',
                            authorId: 'uo_bob',
                            ts: 2000,
                            before: { type: 'paragraph', attrs: {} },
                            after: { type: 'heading', attrs: { level: 2 } },
                        },
                    },
                    content: [{ type: 'text', text: 'Section title' }],
                },
            ],
        })
        const map = new SuggestionsMap(yDoc)
        map.create({ id: 'sbc-1', authorId: 'uo_bob', createdAt: 2000 })

        const result = computeDocumentSuggestions(editor.state.doc, map)
        expect(result.anchored).toHaveLength(1)
        const row = result.anchored[0]
        expect(row.id).toBe('sbc-1')
        expect(row.kind).toBe('block-change')
        expect(row.authorId).toBe('uo_bob')
        expect(row.snippet).toContain('Section title')
        expect(row.beforeBlock).toEqual({ type: 'paragraph', attrs: {} })
        expect(row.afterBlock).toEqual({ type: 'heading', attrs: { level: 2 } })
        editor.destroy()
    })

    it('emits a cell-change AnchoredSuggestion when suggestedBlockChange sits on a tableCell', () => {
        const yDoc = new Y.Doc()
        const editor = makeEditor(
            {
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
                                        attrs: {
                                            colspan: 1,
                                            rowspan: 1,
                                            colwidth: null,
                                            suggestedBlockChange: {
                                                suggestionId: 'scc-1',
                                                authorId: 'uo_carol',
                                                ts: 3000,
                                                before: {
                                                    type: 'tableCell',
                                                    attrs: {},
                                                    added: true,
                                                },
                                                after: {
                                                    type: 'tableCell',
                                                    attrs: {
                                                        colspan: 1,
                                                        rowspan: 1,
                                                        colwidth: null,
                                                    },
                                                },
                                            },
                                        },
                                        content: [
                                            {
                                                type: 'paragraph',
                                                content: [{ type: 'text', text: 'new cell' }],
                                            },
                                        ],
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
            true
        )
        const map = new SuggestionsMap(yDoc)
        map.create({ id: 'scc-1', authorId: 'uo_carol', createdAt: 3000 })

        const result = computeDocumentSuggestions(editor.state.doc, map)
        expect(result.anchored).toHaveLength(1)
        const row = result.anchored[0]
        expect(row.id).toBe('scc-1')
        expect(row.kind).toBe('cell-change')
        expect(row.authorId).toBe('uo_carol')
        // Cell snippet is the literal "Cell" — a cell can be empty in
        // an addRow proposal, so its textContent is unreliable as a
        // visual cue and the parser substitutes a stable label.
        expect(row.snippet).toBe('Cell')
        expect(row.beforeBlock).toEqual({ type: 'tableCell', attrs: {}, added: true })
        expect(row.afterBlock).toMatchObject({ type: 'tableCell' })
        editor.destroy()
    })

    it('cell-change kind also fires for tableHeader nodes', () => {
        const yDoc = new Y.Doc()
        const editor = makeEditor(
            {
                type: 'doc',
                content: [
                    {
                        type: 'table',
                        content: [
                            {
                                type: 'tableRow',
                                content: [
                                    {
                                        type: 'tableHeader',
                                        attrs: {
                                            colspan: 1,
                                            rowspan: 1,
                                            colwidth: null,
                                            suggestedBlockChange: {
                                                suggestionId: 'sch-1',
                                                authorId: 'uo_dave',
                                                ts: 4000,
                                                before: {
                                                    type: 'tableHeader',
                                                    attrs: { colspan: 1, rowspan: 1, colwidth: null },
                                                },
                                                after: {
                                                    type: 'tableHeader',
                                                    attrs: { colspan: 1, rowspan: 1, colwidth: null },
                                                    deleted: true,
                                                },
                                            },
                                        },
                                        content: [
                                            {
                                                type: 'paragraph',
                                                content: [{ type: 'text', text: 'header' }],
                                            },
                                        ],
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
            true
        )
        const map = new SuggestionsMap(yDoc)
        map.create({ id: 'sch-1', authorId: 'uo_dave', createdAt: 4000 })

        const result = computeDocumentSuggestions(editor.state.doc, map)
        expect(result.anchored).toHaveLength(1)
        expect(result.anchored[0].kind).toBe('cell-change')
        editor.destroy()
    })

    it('multi-kind doc (insert + format-change + block-change) surfaces all three rows', () => {
        const yDoc = new Y.Doc()
        const editor = makeEditor({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        {
                            type: 'text',
                            text: 'inserted',
                            marks: [
                                {
                                    type: 'suggestedInsert',
                                    attrs: {
                                        suggestionId: 's-ins',
                                        authorId: 'uo_a',
                                        ts: 100,
                                    },
                                },
                            ],
                        },
                    ],
                },
                {
                    type: 'paragraph',
                    content: [
                        {
                            type: 'text',
                            text: 'restyled',
                            marks: [
                                {
                                    type: 'suggestedFormatChange',
                                    attrs: {
                                        suggestionId: 's-fmt',
                                        authorId: 'uo_b',
                                        ts: 200,
                                        before: [],
                                        after: [{ type: 'italic' }],
                                    },
                                },
                            ],
                        },
                    ],
                },
                {
                    type: 'paragraph',
                    attrs: {
                        suggestedBlockChange: {
                            suggestionId: 's-blk',
                            authorId: 'uo_c',
                            ts: 300,
                            before: { type: 'paragraph', attrs: {} },
                            after: { type: 'heading', attrs: { level: 1 } },
                        },
                    },
                    content: [{ type: 'text', text: 'becomes heading' }],
                },
            ],
        })
        const map = new SuggestionsMap(yDoc)
        map.create({ id: 's-ins', authorId: 'uo_a', createdAt: 100 })
        map.create({ id: 's-fmt', authorId: 'uo_b', createdAt: 200 })
        map.create({ id: 's-blk', authorId: 'uo_c', createdAt: 300 })

        const result = computeDocumentSuggestions(editor.state.doc, map)
        // Three suggestions, one per kind. Sort order is document
        // position: insert(p1) → format-change(p2) → block-change(p3).
        expect(result.anchored).toHaveLength(3)
        expect(result.anchored.map(r => r.kind)).toEqual([
            'insert',
            'format-change',
            'block-change',
        ])
        // Per-row spot-checks of the kind-specific payloads.
        expect(result.anchored[1].afterMarks).toEqual([{ type: 'italic' }])
        expect(result.anchored[2].beforeBlock).toEqual({ type: 'paragraph', attrs: {} })
        expect(result.anchored[2].afterBlock).toEqual({
            type: 'heading',
            attrs: { level: 1 },
        })
        editor.destroy()
    })

    it('stacked suggestedFormatChange marks with the same id consolidate into one row', () => {
        // Case 2c parity: excludes: '' on suggestedFormatChange means
        // a single text node can carry multiple marks for the same
        // suggestionId when one session emits toggleBold then
        // toggleItalic. The parser should produce ONE row per
        // (id, kind), matching how insert/delete consolidate.
        const yDoc = new Y.Doc()
        const editor = makeEditor({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        {
                            type: 'text',
                            text: 'doubled',
                            marks: [
                                {
                                    type: 'suggestedFormatChange',
                                    attrs: {
                                        suggestionId: 'sfc-stack',
                                        authorId: 'uo_alice',
                                        ts: 1000,
                                        before: [],
                                        after: [{ type: 'bold' }],
                                    },
                                },
                                {
                                    type: 'suggestedFormatChange',
                                    attrs: {
                                        suggestionId: 'sfc-stack',
                                        authorId: 'uo_alice',
                                        ts: 1001,
                                        before: [],
                                        after: [{ type: 'italic' }],
                                    },
                                },
                            ],
                        },
                    ],
                },
            ],
        })
        const map = new SuggestionsMap(yDoc)
        map.create({ id: 'sfc-stack', authorId: 'uo_alice', createdAt: 1000 })

        const result = computeDocumentSuggestions(editor.state.doc, map)
        expect(result.anchored).toHaveLength(1)
        expect(result.anchored[0].id).toBe('sfc-stack')
        expect(result.anchored[0].kind).toBe('format-change')
        editor.destroy()
    })
})
