import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Window } from 'happy-dom'
import { DOMParser, DOMSerializer } from 'prosemirror-model'
import { describe, expect, it } from 'vitest'
import { SuggestedDelete } from '~/tinycld/text/webview-editor/source/suggestions/suggested-delete'

describe('SuggestedDelete mark', () => {
    const schema = getSchema([StarterKit, SuggestedDelete])
    const window = new Window()
    const document = window.document as unknown as Document

    it('registers a mark named "suggestedDelete"', () => {
        expect(schema.marks.suggestedDelete).toBeDefined()
    })

    it('parses HTML with data-suggested-delete attributes', () => {
        const html =
            '<p>hello <span data-suggested-delete ' +
            'data-suggestion-id="d1" data-author-id="user-3" data-ts="789">world</span></p>'
        document.body.innerHTML = html
        const node = DOMParser.fromSchema(schema).parse(document.body)
        const inlineWithMark = node.firstChild?.lastChild
        const mark = inlineWithMark?.marks.find(m => m.type.name === 'suggestedDelete')
        expect(mark).toBeDefined()
        expect(mark?.attrs.suggestionId).toBe('d1')
        expect(mark?.attrs.authorId).toBe('user-3')
        expect(mark?.attrs.ts).toBe(789)
    })

    it('renders to HTML with data attributes preserved', () => {
        const deleteMark = schema.marks.suggestedDelete.create({
            suggestionId: 'd2',
            authorId: 'user-4',
            ts: 1011,
        })
        const text = schema.text('deleted text', [deleteMark])
        const paragraph = schema.nodes.paragraph.create({}, text)
        const fragment = DOMSerializer.fromSchema(schema).serializeFragment(paragraph.content, {
            document,
        })
        const container = document.createElement('div')
        container.appendChild(fragment)
        const span = container.querySelector('span[data-suggested-delete]')
        expect(span).not.toBeNull()
        expect(span?.getAttribute('data-suggestion-id')).toBe('d2')
        expect(span?.getAttribute('data-author-id')).toBe('user-4')
        expect(span?.getAttribute('data-ts')).toBe('1011')
    })

    it('drops the mark on parse if data-suggestion-id is missing', () => {
        const html =
            '<p><span data-suggested-delete data-author-id="user-3" data-ts="789">contested</span></p>'
        document.body.innerHTML = html
        const node = DOMParser.fromSchema(schema).parse(document.body)
        const inline = node.firstChild?.firstChild
        const mark = inline?.marks.find(m => m.type.name === 'suggestedDelete')
        expect(mark).toBeUndefined()
    })

    it('drops the mark on parse if data-author-id is missing', () => {
        const html =
            '<p><span data-suggested-delete data-suggestion-id="d1" data-ts="789">contested</span></p>'
        document.body.innerHTML = html
        const node = DOMParser.fromSchema(schema).parse(document.body)
        const inline = node.firstChild?.firstChild
        const mark = inline?.marks.find(m => m.type.name === 'suggestedDelete')
        expect(mark).toBeUndefined()
    })

    it('drops the mark on parse if data-ts is missing', () => {
        const html =
            '<p><span data-suggested-delete data-suggestion-id="d1" data-author-id="user-3">contested</span></p>'
        document.body.innerHTML = html
        const node = DOMParser.fromSchema(schema).parse(document.body)
        const inline = node.firstChild?.firstChild
        const mark = inline?.marks.find(m => m.type.name === 'suggestedDelete')
        expect(mark).toBeUndefined()
    })

    it('allows co-existence with SuggestedInsert on the same range', async () => {
        // Spec Case 2b(i): Bob proposes deletion of text Alice proposed
        // inserting. Both suggestions are independently accept/rejectable —
        // so the SuggestedInsert and SuggestedDelete marks must coexist on
        // the same text run, each carrying its own suggestionId/authorId.
        const { SuggestedInsert } = await import(
            '~/tinycld/text/webview-editor/source/suggestions/suggested-insert'
        )
        const layeredSchema = getSchema([StarterKit, SuggestedInsert, SuggestedDelete])
        const insertMark = layeredSchema.marks.suggestedInsert.create({
            suggestionId: 's-ins',
            authorId: 'alice',
            ts: 1,
        })
        const deleteMark = layeredSchema.marks.suggestedDelete.create({
            suggestionId: 's-del',
            authorId: 'bob',
            ts: 2,
        })
        const text = layeredSchema.text('contested', [insertMark, deleteMark])
        expect(text.marks).toHaveLength(2)
        expect(text.marks.map(m => m.type.name).sort()).toEqual([
            'suggestedDelete',
            'suggestedInsert',
        ])
        // Verify each mark's attrs are independently preserved (defensive
        // against a hypothetical regression where the second mark clobbers
        // the first's attribute storage).
        const ins = text.marks.find(m => m.type.name === 'suggestedInsert')
        const del = text.marks.find(m => m.type.name === 'suggestedDelete')
        expect(ins?.attrs).toEqual({ suggestionId: 's-ins', authorId: 'alice', ts: 1 })
        expect(del?.attrs).toEqual({ suggestionId: 's-del', authorId: 'bob', ts: 2 })
    })
})
