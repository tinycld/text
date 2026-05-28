import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Window } from 'happy-dom'
import { DOMParser, DOMSerializer } from 'prosemirror-model'
import { describe, expect, it } from 'vitest'
import { SuggestedBlockChange } from '~/tinycld/text/webview-editor/source/suggestions/suggested-block-change'

describe('SuggestedBlockChange extension', () => {
    const schema = getSchema([StarterKit, SuggestedBlockChange])
    const window = new Window()
    const document = window.document as unknown as Document

    it('adds suggestedBlockChange attribute to paragraph', () => {
        expect(schema.nodes.paragraph.spec.attrs?.suggestedBlockChange).toBeDefined()
    })

    it('adds suggestedBlockChange attribute to heading', () => {
        expect(schema.nodes.heading.spec.attrs?.suggestedBlockChange).toBeDefined()
    })

    it('default is null for paragraphs without a pending change', () => {
        document.body.innerHTML = '<p>plain</p>'
        const node = DOMParser.fromSchema(schema).parse(document.body)
        expect(node.firstChild?.attrs.suggestedBlockChange).toBeNull()
    })

    it('parses HTML data-block-change attribute as JSON', () => {
        const payload = {
            suggestionId: 's1',
            authorId: 'u1',
            ts: 999,
            before: { type: 'paragraph', attrs: {} },
            after: { type: 'heading', attrs: { level: 2 } },
        }
        const encoded = encodeURIComponent(JSON.stringify(payload))
        document.body.innerHTML = `<p data-block-change="${encoded}">hello</p>`
        const node = DOMParser.fromSchema(schema).parse(document.body)
        const p = node.firstChild
        expect(p?.attrs.suggestedBlockChange).toMatchObject(payload)
    })

    it('round-trips through serialization without data loss', () => {
        const payload = {
            suggestionId: 's2',
            authorId: 'u2',
            ts: 1234,
            before: { type: 'paragraph', attrs: {} },
            after: { type: 'heading', attrs: { level: 1 } },
        }
        const para = schema.nodes.paragraph.create({ suggestedBlockChange: payload })
        const serialized = DOMSerializer.fromSchema(schema).serializeNode(para, { document })
        const container = document.createElement('div')
        container.appendChild(serialized)
        const encoded = container.firstElementChild?.getAttribute('data-block-change')
        expect(encoded).not.toBeNull()
        const decoded = JSON.parse(decodeURIComponent(encoded as string))
        expect(decoded).toMatchObject(payload)
    })

    it('omits the data-block-change attribute when value is null (silent-drop pattern)', () => {
        const para = schema.nodes.paragraph.create({ suggestedBlockChange: null })
        const serialized = DOMSerializer.fromSchema(schema).serializeNode(para, { document })
        const container = document.createElement('div')
        container.appendChild(serialized)
        const span = container.firstElementChild
        expect(span?.hasAttribute('data-block-change')).toBe(false)
    })

    it('returns null on parse if data-block-change is malformed JSON', () => {
        document.body.innerHTML = '<p data-block-change="not-valid-json">bad</p>'
        const node = DOMParser.fromSchema(schema).parse(document.body)
        expect(node.firstChild?.attrs.suggestedBlockChange).toBeNull()
    })
})
