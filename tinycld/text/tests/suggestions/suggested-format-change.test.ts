import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Window } from 'happy-dom'
import { DOMParser, DOMSerializer } from 'prosemirror-model'
import { describe, expect, it } from 'vitest'
import { SuggestedFormatChange } from '~/tinycld/text/webview-editor/source/suggestions/suggested-format-change'
import type { SerializedMarks } from '~/tinycld/text/webview-editor/source/suggestions/suggestion-types'

describe('SuggestedFormatChange mark', () => {
    const schema = getSchema([StarterKit, SuggestedFormatChange])
    const window = new Window()
    const document = window.document as unknown as Document

    it('registers a mark named "suggestedFormatChange"', () => {
        expect(schema.marks.suggestedFormatChange).toBeDefined()
    })

    it('has the expected attribute defaults', () => {
        const created = schema.marks.suggestedFormatChange.create({})
        expect(created.attrs.suggestionId).toBeNull()
        expect(created.attrs.authorId).toBeNull()
        expect(created.attrs.ts).toBeNull()
        expect(created.attrs.before).toBeNull()
        expect(created.attrs.after).toBeNull()
    })

    it('stores and returns attribute values when explicitly set', () => {
        const before: SerializedMarks = [{ type: 'bold' }]
        const after: SerializedMarks = [{ type: 'bold' }, { type: 'italic' }]
        const mark = schema.marks.suggestedFormatChange.create({
            suggestionId: 'sfc-1',
            authorId: 'user-1',
            ts: 12345,
            before,
            after,
        })
        expect(mark.attrs.suggestionId).toBe('sfc-1')
        expect(mark.attrs.authorId).toBe('user-1')
        expect(mark.attrs.ts).toBe(12345)
        expect(mark.attrs.before).toEqual(before)
        expect(mark.attrs.after).toEqual(after)
    })

    it('parses HTML with data-suggested-format-change attributes', () => {
        const before: SerializedMarks = [{ type: 'bold' }]
        const after: SerializedMarks = [{ type: 'bold' }, { type: 'italic' }]
        const beforeEncoded = encodeURIComponent(JSON.stringify(before))
        const afterEncoded = encodeURIComponent(JSON.stringify(after))
        const html =
            `<p>hello <span data-suggested-format-change ` +
            `data-suggestion-id="abc" data-author-id="user-1" data-ts="123" ` +
            `data-before="${beforeEncoded}" data-after="${afterEncoded}">world</span></p>`
        document.body.innerHTML = html
        const node = DOMParser.fromSchema(schema).parse(document.body)
        const inlineWithMark = node.firstChild?.lastChild
        const mark = inlineWithMark?.marks.find(m => m.type.name === 'suggestedFormatChange')
        expect(mark).toBeDefined()
        expect(mark?.attrs.suggestionId).toBe('abc')
        expect(mark?.attrs.authorId).toBe('user-1')
        expect(mark?.attrs.ts).toBe(123)
        expect(mark?.attrs.before).toEqual(before)
        expect(mark?.attrs.after).toEqual(after)
    })

    it('renders to HTML with data attributes preserved', () => {
        const before: SerializedMarks = [{ type: 'italic' }]
        const after: SerializedMarks = [
            { type: 'italic' },
            { type: 'link', attrs: { href: 'https://example.com' } },
        ]
        const fcMark = schema.marks.suggestedFormatChange.create({
            suggestionId: 'xyz',
            authorId: 'user-2',
            ts: 456,
            before,
            after,
        })
        const text = schema.text('linked italic', [fcMark])
        const paragraph = schema.nodes.paragraph.create({}, text)
        const fragment = DOMSerializer.fromSchema(schema).serializeFragment(paragraph.content, {
            document,
        })
        const container = document.createElement('div')
        container.appendChild(fragment)
        const span = container.querySelector('span[data-suggested-format-change]')
        expect(span).not.toBeNull()
        expect(span?.getAttribute('data-suggestion-id')).toBe('xyz')
        expect(span?.getAttribute('data-author-id')).toBe('user-2')
        expect(span?.getAttribute('data-ts')).toBe('456')
        const beforeRaw = span?.getAttribute('data-before')
        const afterRaw = span?.getAttribute('data-after')
        expect(beforeRaw).not.toBeNull()
        expect(afterRaw).not.toBeNull()
        expect(JSON.parse(decodeURIComponent(beforeRaw as string))).toEqual(before)
        expect(JSON.parse(decodeURIComponent(afterRaw as string))).toEqual(after)
    })

    it('round-trips through serialize → parse without data loss', () => {
        const before: SerializedMarks = [{ type: 'textStyle', attrs: { color: '#f00' } }]
        const after: SerializedMarks = [
            { type: 'textStyle', attrs: { color: '#0f0' } },
            { type: 'bold' },
        ]
        const fcMark = schema.marks.suggestedFormatChange.create({
            suggestionId: 'rt-1',
            authorId: 'user-rt',
            ts: 789,
            before,
            after,
        })
        const text = schema.text('round-trip', [fcMark])
        const paragraph = schema.nodes.paragraph.create({}, text)
        const fragment = DOMSerializer.fromSchema(schema).serializeFragment(paragraph.content, {
            document,
        })
        const container = document.createElement('div')
        container.appendChild(fragment)
        document.body.innerHTML = ''
        document.body.appendChild(container)
        const reparsed = DOMParser.fromSchema(schema).parse(document.body)
        const inlineWithMark = reparsed.firstChild?.firstChild
        const reparsedMark = inlineWithMark?.marks.find(
            m => m.type.name === 'suggestedFormatChange'
        )
        expect(reparsedMark).toBeDefined()
        expect(reparsedMark?.attrs.suggestionId).toBe('rt-1')
        expect(reparsedMark?.attrs.authorId).toBe('user-rt')
        expect(reparsedMark?.attrs.ts).toBe(789)
        expect(reparsedMark?.attrs.before).toEqual(before)
        expect(reparsedMark?.attrs.after).toEqual(after)
    })

    it('drops the mark on parse if data-suggestion-id is missing', () => {
        const html =
            '<p><span data-suggested-format-change ' +
            'data-author-id="user-1" data-ts="123" data-before="%5B%5D" data-after="%5B%5D">x</span></p>'
        document.body.innerHTML = html
        const node = DOMParser.fromSchema(schema).parse(document.body)
        const inline = node.firstChild?.firstChild
        const mark = inline?.marks.find(m => m.type.name === 'suggestedFormatChange')
        expect(mark).toBeUndefined()
    })

    it('drops the mark on parse if data-before is missing', () => {
        const html =
            '<p><span data-suggested-format-change ' +
            'data-suggestion-id="abc" data-author-id="user-1" data-ts="123" data-after="%5B%5D">x</span></p>'
        document.body.innerHTML = html
        const node = DOMParser.fromSchema(schema).parse(document.body)
        const inline = node.firstChild?.firstChild
        const mark = inline?.marks.find(m => m.type.name === 'suggestedFormatChange')
        expect(mark).toBeUndefined()
    })

    it('drops the mark on parse if data-after is missing', () => {
        const html =
            '<p><span data-suggested-format-change ' +
            'data-suggestion-id="abc" data-author-id="user-1" data-ts="123" data-before="%5B%5D">x</span></p>'
        document.body.innerHTML = html
        const node = DOMParser.fromSchema(schema).parse(document.body)
        const inline = node.firstChild?.firstChild
        const mark = inline?.marks.find(m => m.type.name === 'suggestedFormatChange')
        expect(mark).toBeUndefined()
    })
})
