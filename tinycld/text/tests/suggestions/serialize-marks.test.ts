import { getSchema, Mark, mergeAttributes } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { describe, expect, it } from 'vitest'
import { deserializeMarks, serializeMarks } from '~/tinycld/text/lib/suggestions/serialize-marks'
import type { SerializedMarks } from '~/tinycld/text/webview-editor/source/suggestions/suggestion-types'

// A minimal local Link-like mark with an href attribute so we can
// exercise the attrs round-trip path without pulling in the full
// @tiptap/extension-link package and its DOM expectations.
const LinkLike = Mark.create({
    name: 'linkLike',
    addAttributes() {
        return {
            href: {
                default: null,
                parseHTML: el => el.getAttribute('href'),
                renderHTML: attrs => {
                    if (!attrs.href) return {}
                    return { href: attrs.href }
                },
            },
        }
    },
    parseHTML() {
        return [{ tag: 'a[href]' }]
    },
    renderHTML({ HTMLAttributes }) {
        return ['a', mergeAttributes(HTMLAttributes), 0]
    },
})

describe('serializeMarks', () => {
    const schema = getSchema([StarterKit, LinkLike])

    it('returns an empty array for an empty input', () => {
        expect(serializeMarks([])).toEqual([])
    })

    it('serializes a single attribute-less mark to a type-only entry', () => {
        const bold = schema.marks.bold.create()
        const serialized = serializeMarks([bold])
        expect(serialized).toEqual([{ type: 'bold' }])
        // No `attrs` key when the mark has none — keeps the JSON shape
        // tight and stable for diffing in the suggestion drawer.
        expect(serialized[0]).not.toHaveProperty('attrs')
    })

    it('serializes a mark with attrs and preserves them', () => {
        const link = schema.marks.linkLike.create({ href: 'https://example.com' })
        const serialized = serializeMarks([link])
        expect(serialized).toEqual([{ type: 'linkLike', attrs: { href: 'https://example.com' } }])
    })

    it('serializes a multi-mark set in input order', () => {
        const bold = schema.marks.bold.create()
        const italic = schema.marks.italic.create()
        const link = schema.marks.linkLike.create({ href: 'https://x.example' })
        const serialized = serializeMarks([bold, italic, link])
        expect(serialized).toEqual([
            { type: 'bold' },
            { type: 'italic' },
            { type: 'linkLike', attrs: { href: 'https://x.example' } },
        ])
    })

    it('clones attrs rather than aliasing the original mark.attrs reference', () => {
        const link = schema.marks.linkLike.create({ href: 'https://example.com' })
        const serialized = serializeMarks([link])
        // Mutating the serialized entry must not bleed back into the source mark.
        ;(serialized[0].attrs as Record<string, unknown>).href = 'https://changed.example'
        expect(link.attrs.href).toBe('https://example.com')
    })
})

describe('deserializeMarks', () => {
    const schema = getSchema([StarterKit, LinkLike])

    it('returns an empty array for an empty serialized input', () => {
        expect(deserializeMarks([], schema)).toEqual([])
    })

    it('deserializes a single attribute-less mark', () => {
        const serialized: SerializedMarks = [{ type: 'bold' }]
        const marks = deserializeMarks(serialized, schema)
        expect(marks).toHaveLength(1)
        expect(marks[0].type.name).toBe('bold')
    })

    it('deserializes a mark with attrs and preserves them', () => {
        const serialized: SerializedMarks = [
            { type: 'linkLike', attrs: { href: 'https://example.com' } },
        ]
        const marks = deserializeMarks(serialized, schema)
        expect(marks).toHaveLength(1)
        expect(marks[0].type.name).toBe('linkLike')
        expect(marks[0].attrs.href).toBe('https://example.com')
    })

    it('silently drops marks whose type is not in the schema', () => {
        const serialized: SerializedMarks = [
            { type: 'bold' },
            { type: 'unknownMarkType', attrs: { foo: 'bar' } },
            { type: 'italic' },
        ]
        // The unknown entry must not throw — same silent-drop philosophy
        // as the suggestion mark parseHTMLs.
        expect(() => deserializeMarks(serialized, schema)).not.toThrow()
        const marks = deserializeMarks(serialized, schema)
        expect(marks.map(m => m.type.name)).toEqual(['bold', 'italic'])
    })
})

describe('serializeMarks ↔ deserializeMarks round-trip', () => {
    const schema = getSchema([StarterKit, LinkLike])

    it('round-trips an empty array', () => {
        const round = serializeMarks(deserializeMarks([], schema))
        expect(round).toEqual([])
    })

    it('round-trips a single bold mark', () => {
        const original = [schema.marks.bold.create()]
        const serialized = serializeMarks(original)
        const back = deserializeMarks(serialized, schema)
        expect(back.map(m => m.type.name)).toEqual(['bold'])
        expect(serializeMarks(back)).toEqual(serialized)
    })

    it('round-trips a mark with attrs (linkLike with href)', () => {
        const original = [schema.marks.linkLike.create({ href: 'https://example.com' })]
        const serialized = serializeMarks(original)
        const back = deserializeMarks(serialized, schema)
        expect(back).toHaveLength(1)
        expect(back[0].type.name).toBe('linkLike')
        expect(back[0].attrs.href).toBe('https://example.com')
        expect(serializeMarks(back)).toEqual(serialized)
    })

    it('round-trips a mixed mark set in order', () => {
        const original = [
            schema.marks.bold.create(),
            schema.marks.italic.create(),
            schema.marks.linkLike.create({ href: 'https://x.example' }),
        ]
        const serialized = serializeMarks(original)
        const back = deserializeMarks(serialized, schema)
        expect(back.map(m => m.type.name)).toEqual(['bold', 'italic', 'linkLike'])
        expect(serializeMarks(back)).toEqual(serialized)
    })
})
