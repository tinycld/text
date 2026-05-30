import { getSchema } from '@tiptap/core'
import { Table } from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import StarterKit from '@tiptap/starter-kit'
import { EditorState } from 'prosemirror-state'
import { describe, expect, it } from 'vitest'
import { colorForUser } from '~/tinycld/text/lib/color-for-user'
import { buildSuggestionEditorExtensions } from '~/tinycld/text/lib/suggestions/build-extensions'
import {
    createSuggestionDecorationsPlugin,
    getSuggestionDecorations,
    summarizeBlockChange,
} from '~/tinycld/text/lib/suggestions/decorations'
import type {
    BlockChangeAfter,
    BlockChangeBefore,
} from '~/tinycld/text/webview-editor/source/suggestions/suggestion-types'

// makeStateWithBlockChange builds a one-block doc carrying a
// suggestedBlockChange attribute, without touching the command layer.
// Direct schema construction (vs. running suggesting-mode commands)
// keeps the decoration tests focused on the decoration plugin and
// independent of the interception path's own tests.
function makeStateWithBlockChange(opts: {
    blockType: 'paragraph' | 'heading'
    blockAttrs?: Record<string, unknown>
    suggestionId: string
    authorId: string
    before: BlockChangeBefore
    after: BlockChangeAfter
    text?: string
}) {
    const schema = getSchema([StarterKit, ...buildSuggestionEditorExtensions()])
    const payload = {
        suggestionId: opts.suggestionId,
        authorId: opts.authorId,
        ts: 1000,
        before: opts.before,
        after: opts.after,
    }
    const nodeType = schema.nodes[opts.blockType]
    const text = opts.text ?? 'hello'
    const block = nodeType.create(
        {
            ...(opts.blockAttrs ?? {}),
            suggestedBlockChange: payload,
        },
        schema.text(text)
    )
    const docNode = schema.nodes.doc.create({}, block)
    return EditorState.create({
        doc: docNode,
        schema,
        plugins: [createSuggestionDecorationsPlugin()],
    })
}

function findBlockChangeDeco(state: EditorState) {
    const decoSet = getSuggestionDecorations(state)
    return decoSet.find().find(d => d.spec?.kind === 'suggestedBlockChange')
}

// decorationAttrs grabs the attrs object the plugin emitted (class,
// style, title). The Decoration class stores them on `type.attrs` for
// inline + node decorations; we treat the result as a string-valued
// record because that's the shape DOM attributes always have.
function decorationAttrs(deco: unknown): Record<string, string> {
    return (deco as { type: { attrs: Record<string, string> } }).type.attrs
}

describe('SuggestionDecorations — suggestedBlockChange', () => {
    it('emits a block-change decoration for a node carrying suggestedBlockChange', () => {
        const state = makeStateWithBlockChange({
            blockType: 'paragraph',
            suggestionId: 's-bc',
            authorId: 'uo_alice',
            before: { type: 'paragraph', attrs: {} },
            after: { type: 'heading', attrs: { level: 2 } },
        })
        const deco = findBlockChangeDeco(state)
        expect(deco).toBeDefined()
        expect(deco?.spec?.suggestionId).toBe('s-bc')
        expect(deco?.spec?.authorId).toBe('uo_alice')
    })

    it('decoration carries a colored left-border bar in the author color', () => {
        const state = makeStateWithBlockChange({
            blockType: 'paragraph',
            suggestionId: 's-bc',
            authorId: 'uo_alice',
            before: { type: 'paragraph', attrs: {} },
            after: { type: 'heading', attrs: { level: 2 } },
        })
        const deco = findBlockChangeDeco(state)
        expect(deco).toBeDefined()
        const attrs = decorationAttrs(deco)
        const expectedColor = colorForUser('uo_alice')
        expect(attrs.style).toContain('border-left')
        expect(attrs.style).toContain('3px solid')
        expect(attrs.style).toContain(expectedColor)
        expect(attrs.class).toBe('tinycld-suggestion-block-change')
    })

    it('delete sub-case combines gutter bar with 0.5 opacity overlay', () => {
        const state = makeStateWithBlockChange({
            blockType: 'paragraph',
            suggestionId: 's-bc-del',
            authorId: 'uo_alice',
            before: { type: 'paragraph', attrs: {} },
            after: { type: 'paragraph', attrs: {}, deleted: true },
        })
        const deco = findBlockChangeDeco(state)
        expect(deco).toBeDefined()
        const attrs = decorationAttrs(deco)
        expect(attrs.style).toContain('border-left')
        expect(attrs.style).toContain('opacity: 0.5')
    })

    it('type-swap sub-case has no opacity overlay', () => {
        const state = makeStateWithBlockChange({
            blockType: 'paragraph',
            suggestionId: 's-bc-swap',
            authorId: 'uo_alice',
            before: { type: 'paragraph', attrs: {} },
            after: { type: 'heading', attrs: { level: 2 } },
        })
        const deco = findBlockChangeDeco(state)
        const attrs = decorationAttrs(deco)
        expect(attrs.style).not.toContain('opacity')
    })

    it('attr-only sub-case has no opacity overlay', () => {
        const state = makeStateWithBlockChange({
            blockType: 'heading',
            blockAttrs: { level: 1 },
            suggestionId: 's-bc-attr',
            authorId: 'uo_alice',
            before: { type: 'heading', attrs: { level: 1 } },
            after: { type: 'heading', attrs: { level: 2 } },
        })
        const deco = findBlockChangeDeco(state)
        const attrs = decorationAttrs(deco)
        expect(attrs.style).not.toContain('opacity')
    })

    it("type-swap tooltip reads 'change to heading 2'", () => {
        const state = makeStateWithBlockChange({
            blockType: 'paragraph',
            suggestionId: 's-bc',
            authorId: 'uo_alice',
            before: { type: 'paragraph', attrs: {} },
            after: { type: 'heading', attrs: { level: 2 } },
        })
        const deco = findBlockChangeDeco(state)
        const attrs = decorationAttrs(deco)
        expect(attrs.title).toContain('uo_alice')
        expect(attrs.title).toContain('change to heading 2')
    })

    it('attr-only tooltip names the changed attribute and value', () => {
        const state = makeStateWithBlockChange({
            blockType: 'paragraph',
            suggestionId: 's-bc',
            authorId: 'uo_alice',
            before: { type: 'paragraph', attrs: { textAlign: null } },
            after: { type: 'paragraph', attrs: { textAlign: 'center' } },
        })
        const deco = findBlockChangeDeco(state)
        const attrs = decorationAttrs(deco)
        expect(attrs.title).toContain('alignment: center')
    })

    it("delete tooltip reads 'delete <block type>'", () => {
        const state = makeStateWithBlockChange({
            blockType: 'paragraph',
            suggestionId: 's-bc-del',
            authorId: 'uo_alice',
            before: { type: 'paragraph', attrs: {} },
            after: { type: 'paragraph', attrs: {}, deleted: true },
        })
        const deco = findBlockChangeDeco(state)
        const attrs = decorationAttrs(deco)
        expect(attrs.title).toContain('delete paragraph')
    })

    it('emits no block-change decoration for an unmarked block', () => {
        const schema = getSchema([StarterKit, ...buildSuggestionEditorExtensions()])
        const docNode = schema.nodes.doc.create(
            {},
            schema.nodes.paragraph.create({}, schema.text('plain text'))
        )
        const state = EditorState.create({
            doc: docNode,
            schema,
            plugins: [createSuggestionDecorationsPlugin()],
        })
        const decoSet = getSuggestionDecorations(state)
        const hasBlockDeco = decoSet.find().some(d => d.spec?.kind === 'suggestedBlockChange')
        expect(hasBlockDeco).toBe(false)
    })

    it('silently drops a malformed payload instead of throwing', () => {
        // Defensive: a payload missing the required `authorId` /
        // before / after fields should be ignored, not crash the
        // plugin. The schema allows any JSON-shaped value on
        // suggestedBlockChange (parseHTML returns whatever JSON parses)
        // so the decoration plugin owns the validation gate.
        const schema = getSchema([StarterKit, ...buildSuggestionEditorExtensions()])
        const block = schema.nodes.paragraph.create(
            { suggestedBlockChange: { suggestionId: 'broken' } },
            schema.text('hi')
        )
        const docNode = schema.nodes.doc.create({}, block)
        const state = EditorState.create({
            doc: docNode,
            schema,
            plugins: [createSuggestionDecorationsPlugin()],
        })
        const decoSet = getSuggestionDecorations(state)
        const hasBlockDeco = decoSet.find().some(d => d.spec?.kind === 'suggestedBlockChange')
        expect(hasBlockDeco).toBe(false)
    })
})

describe('summarizeBlockChange', () => {
    it("describes a heading type-swap as 'change to heading <level>'", () => {
        expect(
            summarizeBlockChange(
                { type: 'paragraph', attrs: {} },
                { type: 'heading', attrs: { level: 2 } }
            )
        ).toBe('change to heading 2')
    })

    it("describes a type-swap with no level as 'change to <type>'", () => {
        expect(
            summarizeBlockChange(
                { type: 'paragraph', attrs: {} },
                { type: 'blockquote', attrs: {} }
            )
        ).toBe('change to blockquote')
    })

    it("describes a same-type alignment swap as 'alignment: center'", () => {
        expect(
            summarizeBlockChange(
                { type: 'paragraph', attrs: { textAlign: null } },
                { type: 'paragraph', attrs: { textAlign: 'center' } }
            )
        ).toBe('alignment: center')
    })

    it("describes a heading-level attr change as 'heading level: 2'", () => {
        expect(
            summarizeBlockChange(
                { type: 'heading', attrs: { level: 1 } },
                { type: 'heading', attrs: { level: 2 } }
            )
        ).toBe('heading level: 2')
    })

    it("describes a delete as 'delete <type>'", () => {
        expect(
            summarizeBlockChange(
                { type: 'paragraph', attrs: {} },
                { type: 'paragraph', attrs: {}, deleted: true }
            )
        ).toBe('delete paragraph')
    })

    it('describes a delete on a heading using the heading label', () => {
        expect(
            summarizeBlockChange(
                { type: 'heading', attrs: { level: 2 } },
                { type: 'heading', attrs: { level: 2 }, deleted: true }
            )
        ).toBe('delete heading 2')
    })

    it('combines type and attr changes in one summary', () => {
        expect(
            summarizeBlockChange(
                { type: 'paragraph', attrs: { textAlign: null } },
                { type: 'heading', attrs: { level: 2, textAlign: 'left' } }
            )
        ).toBe('change to heading 2 (alignment: left)')
    })

    it('joins multiple attr changes with a separator', () => {
        const summary = summarizeBlockChange(
            { type: 'paragraph', attrs: { textAlign: null, indent: 0 } },
            { type: 'paragraph', attrs: { textAlign: 'center', indent: 1 } }
        )
        expect(summary).toContain('alignment: center')
        expect(summary).toContain('indent: 1')
    })

    it("renders null/undefined values as 'default'", () => {
        expect(
            summarizeBlockChange(
                { type: 'paragraph', attrs: { textAlign: 'center' } },
                { type: 'paragraph', attrs: { textAlign: null } }
            )
        ).toBe('alignment: default')
    })

    it("falls back to 'change block' when before and after are indistinguishable", () => {
        // Defensive — the command layer never stamps this, but the
        // function should not throw or return an empty string when
        // handed a no-op payload.
        expect(
            summarizeBlockChange({ type: 'paragraph', attrs: {} }, { type: 'paragraph', attrs: {} })
        ).toBe('change block')
    })

    // Phase 5 Task 14 — table-cell-specific summaries.
    it("describes an added cell as 'add cell'", () => {
        expect(
            summarizeBlockChange(
                {
                    type: 'tableCell',
                    attrs: { colspan: 1, rowspan: 1, colwidth: null },
                    added: true,
                },
                { type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: null } }
            )
        ).toBe('add cell')
    })

    it("describes an added header cell as 'add header cell'", () => {
        expect(
            summarizeBlockChange(
                {
                    type: 'tableHeader',
                    attrs: { colspan: 1, rowspan: 1, colwidth: null },
                    added: true,
                },
                { type: 'tableHeader', attrs: { colspan: 1, rowspan: 1, colwidth: null } }
            )
        ).toBe('add header cell')
    })

    it("describes a deleted cell as 'delete cell'", () => {
        expect(
            summarizeBlockChange(
                { type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: null } },
                {
                    type: 'tableCell',
                    attrs: { colspan: 1, rowspan: 1, colwidth: null },
                    deleted: true,
                }
            )
        ).toBe('delete cell')
    })

    it("describes a colspan change as 'column span: 2'", () => {
        expect(
            summarizeBlockChange(
                { type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: null } },
                { type: 'tableCell', attrs: { colspan: 2, rowspan: 1, colwidth: null } }
            )
        ).toBe('column span: 2')
    })
})

// makeTableStateWithCellChange builds a tiny 1x1 table doc with a
// suggestedBlockChange attribute on the single cell, so cell-specific
// decoration styling can be exercised without standing up the full
// command-layer pipeline.
function makeTableStateWithCellChange(opts: {
    cellType: 'tableCell' | 'tableHeader'
    suggestionId: string
    authorId: string
    before: BlockChangeBefore
    after: BlockChangeAfter
}) {
    const schema = getSchema([
        StarterKit,
        Table.configure({ resizable: false }),
        TableRow,
        TableCell,
        TableHeader,
        ...buildSuggestionEditorExtensions(),
    ])
    const payload = {
        suggestionId: opts.suggestionId,
        authorId: opts.authorId,
        ts: 1000,
        before: opts.before,
        after: opts.after,
    }
    const cellAttrs: Record<string, unknown> = {
        colspan: 1,
        rowspan: 1,
        colwidth: null,
        suggestedBlockChange: payload,
    }
    const cellNodeType = schema.nodes[opts.cellType]
    const cell = cellNodeType.create(
        cellAttrs,
        schema.nodes.paragraph.create({}, schema.text('hi'))
    )
    const row = schema.nodes.tableRow.create({}, cell)
    const table = schema.nodes.table.create({}, row)
    const docNode = schema.nodes.doc.create({}, table)
    return EditorState.create({
        doc: docNode,
        schema,
        plugins: [createSuggestionDecorationsPlugin()],
    })
}

function findCellChangeDeco(state: EditorState) {
    const decoSet = getSuggestionDecorations(state)
    return decoSet.find().find(d => d.spec?.kind === 'suggestedBlockChange') as
        | { spec: Record<string, unknown>; type: { attrs: Record<string, string> } }
        | undefined
}

describe('SuggestionDecorations — suggestedBlockChange on table cells', () => {
    it("added cell shows 'add cell' tooltip", () => {
        const state = makeTableStateWithCellChange({
            cellType: 'tableCell',
            suggestionId: 's-cell-add',
            authorId: 'uo_alice',
            before: {
                type: 'tableCell',
                attrs: { colspan: 1, rowspan: 1, colwidth: null },
                added: true,
            },
            after: { type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: null } },
        })
        const deco = findCellChangeDeco(state)
        expect(deco).toBeDefined()
        const attrs = deco?.type.attrs as Record<string, string>
        expect(attrs.title).toContain('add cell')
        // Cells get the cell-specific class so CSS can target them.
        expect(attrs.class).toContain('tinycld-suggestion-cell-change')
        // Added cells use green borders on left + top — a fixed
        // semantic color, not the author hue.
        expect(attrs.style).toContain('border-left')
        expect(attrs.style).toContain('border-top')
    })

    it("deleted cell shows 'delete cell' tooltip and opacity overlay", () => {
        const state = makeTableStateWithCellChange({
            cellType: 'tableCell',
            suggestionId: 's-cell-del',
            authorId: 'uo_alice',
            before: { type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: null } },
            after: {
                type: 'tableCell',
                attrs: { colspan: 1, rowspan: 1, colwidth: null },
                deleted: true,
            },
        })
        const deco = findCellChangeDeco(state)
        expect(deco).toBeDefined()
        const attrs = deco?.type.attrs as Record<string, string>
        expect(attrs.title).toContain('delete cell')
        // Deleted cells get red borders on left + bottom + opacity 0.5.
        expect(attrs.style).toContain('border-left')
        expect(attrs.style).toContain('border-bottom')
        expect(attrs.style).toContain('opacity: 0.5')
    })

    it('attr-change on a cell uses the author color for the left border', () => {
        const state = makeTableStateWithCellChange({
            cellType: 'tableCell',
            suggestionId: 's-cell-attr',
            authorId: 'uo_alice',
            before: { type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: null } },
            after: { type: 'tableCell', attrs: { colspan: 2, rowspan: 1, colwidth: null } },
        })
        const deco = findCellChangeDeco(state)
        expect(deco).toBeDefined()
        const attrs = deco?.type.attrs as Record<string, string>
        // Author-colored border, no opacity overlay.
        expect(attrs.style).toContain(colorForUser('uo_alice'))
        expect(attrs.style).not.toContain('opacity')
        expect(attrs.title).toContain('column span: 2')
    })
})
