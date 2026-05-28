import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Window } from 'happy-dom'
import { DOMParser, DOMSerializer } from 'prosemirror-model'
import { describe, expect, it } from 'vitest'
import { SuggestedInsert } from '~/tinycld/text/webview-editor/source/suggestions/suggested-insert'

describe('SuggestedInsert mark', () => {
    const schema = getSchema([StarterKit, SuggestedInsert])
    const window = new Window()
    const document = window.document as unknown as Document

    it('registers a mark named "suggestedInsert"', () => {
        expect(schema.marks.suggestedInsert).toBeDefined()
    })

    it('parses HTML with data-suggested-insert attributes', () => {
        const html =
            '<p>hello <span data-suggested-insert ' +
            'data-suggestion-id="abc" data-author-id="user-1" data-ts="123">world</span></p>'
        document.body.innerHTML = html
        const node = DOMParser.fromSchema(schema).parse(document.body)
        const inlineWithMark = node.firstChild?.lastChild
        const mark = inlineWithMark?.marks.find(m => m.type.name === 'suggestedInsert')
        expect(mark).toBeDefined()
        expect(mark?.attrs.suggestionId).toBe('abc')
        expect(mark?.attrs.authorId).toBe('user-1')
        expect(mark?.attrs.ts).toBe(123)
    })

    it('renders to HTML with data attributes preserved', () => {
        const insertMark = schema.marks.suggestedInsert.create({
            suggestionId: 'xyz',
            authorId: 'user-2',
            ts: 456,
        })
        const text = schema.text('inserted text', [insertMark])
        const paragraph = schema.nodes.paragraph.create({}, text)
        const fragment = DOMSerializer.fromSchema(schema).serializeFragment(paragraph.content, {
            document,
        })
        const container = document.createElement('div')
        container.appendChild(fragment)
        const span = container.querySelector('span[data-suggested-insert]')
        expect(span).not.toBeNull()
        expect(span?.getAttribute('data-suggestion-id')).toBe('xyz')
        expect(span?.getAttribute('data-author-id')).toBe('user-2')
        expect(span?.getAttribute('data-ts')).toBe('456')
    })

    it('drops the mark on parse if data-suggestion-id is missing', () => {
        const html =
            '<p><span data-suggested-insert data-author-id="user-1" data-ts="123">contested</span></p>'
        document.body.innerHTML = html
        const node = DOMParser.fromSchema(schema).parse(document.body)
        const inline = node.firstChild?.firstChild
        const mark = inline?.marks.find(m => m.type.name === 'suggestedInsert')
        expect(mark).toBeUndefined()
    })

    it('drops the mark on parse if data-author-id is missing', () => {
        const html =
            '<p><span data-suggested-insert data-suggestion-id="abc" data-ts="123">contested</span></p>'
        document.body.innerHTML = html
        const node = DOMParser.fromSchema(schema).parse(document.body)
        const inline = node.firstChild?.firstChild
        const mark = inline?.marks.find(m => m.type.name === 'suggestedInsert')
        expect(mark).toBeUndefined()
    })

    it('drops the mark on parse if data-ts is missing', () => {
        const html =
            '<p><span data-suggested-insert data-suggestion-id="abc" data-author-id="user-1">contested</span></p>'
        document.body.innerHTML = html
        const node = DOMParser.fromSchema(schema).parse(document.body)
        const inline = node.firstChild?.firstChild
        const mark = inline?.marks.find(m => m.type.name === 'suggestedInsert')
        expect(mark).toBeUndefined()
    })
})
