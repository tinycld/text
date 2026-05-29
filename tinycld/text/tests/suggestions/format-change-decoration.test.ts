import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { EditorState } from 'prosemirror-state'
import { describe, expect, it } from 'vitest'
import { colorForUser } from '~/tinycld/text/lib/color-for-user'
import { buildSuggestionEditorExtensions } from '~/tinycld/text/lib/suggestions/build-extensions'
import {
    createSuggestionDecorationsPlugin,
    getSuggestionDecorations,
    summarizeFormatChange,
} from '~/tinycld/text/lib/suggestions/decorations'
import type { SerializedMarks } from '~/tinycld/text/webview-editor/source/suggestions/suggestion-types'

// Build a state with a single paragraph containing one text node
// carrying a suggestedFormatChange mark. Lets us assert against the
// decoration plugin's output without standing up a full Editor / DOM.
function makeStateWithFormatChange(
    text: string,
    attrs: {
        suggestionId: string
        authorId: string
        ts: number
        before: SerializedMarks
        after: SerializedMarks
    }
) {
    const schema = getSchema([StarterKit, ...buildSuggestionEditorExtensions()])
    const mark = schema.marks.suggestedFormatChange.create(attrs)
    const textNode = schema.text(text, [mark])
    const docNode = schema.nodes.doc.create({}, schema.nodes.paragraph.create({}, textNode))
    return EditorState.create({
        doc: docNode,
        schema,
        plugins: [createSuggestionDecorationsPlugin()],
    })
}

describe('SuggestionDecorations — suggestedFormatChange', () => {
    it('emits a format-change decoration for a suggestedFormatChange mark', () => {
        const state = makeStateWithFormatChange('hello', {
            suggestionId: 's-fc',
            authorId: 'uo_alice',
            ts: 1000,
            before: [],
            after: [{ type: 'bold' }],
        })
        const decoSet = getSuggestionDecorations(state)
        const decos = decoSet.find()
        const fcDeco = decos.find(d => d.spec?.kind === 'suggestedFormatChange')
        expect(fcDeco).toBeDefined()
        expect(fcDeco?.spec?.suggestionId).toBe('s-fc')
        expect(fcDeco?.spec?.authorId).toBe('uo_alice')
    })

    it('decoration carries the author color underline', () => {
        const state = makeStateWithFormatChange('hello', {
            suggestionId: 's-fc',
            authorId: 'uo_alice',
            ts: 1000,
            before: [],
            after: [{ type: 'bold' }],
        })
        const decoSet = getSuggestionDecorations(state)
        const decos = decoSet.find()
        const fcDeco = decos.find(d => d.spec?.kind === 'suggestedFormatChange')
        expect(fcDeco).toBeDefined()
        // The decoration type stores its attrs on `type.attrs` for an
        // inline decoration. We access through the public `find()`
        // result; the style attribute is the load-bearing rendering
        // signal that becomes a span style attribute in the DOM.
        const attrs = (fcDeco as unknown as { type: { attrs: Record<string, string> } }).type.attrs
        const expectedColor = colorForUser('uo_alice')
        expect(attrs.style).toContain('border-bottom')
        expect(attrs.style).toContain(expectedColor)
        expect(attrs.class).toBe('tinycld-suggestion-format-change')
    })

    it('decoration carries a tooltip title summarizing the change', () => {
        const state = makeStateWithFormatChange('hello', {
            suggestionId: 's-fc',
            authorId: 'uo_alice',
            ts: 1000,
            before: [],
            after: [{ type: 'bold' }],
        })
        const decoSet = getSuggestionDecorations(state)
        const decos = decoSet.find()
        const fcDeco = decos.find(d => d.spec?.kind === 'suggestedFormatChange')
        expect(fcDeco).toBeDefined()
        const attrs = (fcDeco as unknown as { type: { attrs: Record<string, string> } }).type.attrs
        expect(attrs.title).toContain('uo_alice')
        expect(attrs.title.toLowerCase()).toContain('bold')
    })

    it('coexists with suggestedInsert decoration on the same range (Case 2b stacking)', () => {
        const schema = getSchema([StarterKit, ...buildSuggestionEditorExtensions()])
        const insertMark = schema.marks.suggestedInsert.create({
            suggestionId: 's-ins',
            authorId: 'uo_alice',
            ts: 1000,
        })
        const fcMark = schema.marks.suggestedFormatChange.create({
            suggestionId: 's-fc',
            authorId: 'uo_bob',
            ts: 2000,
            before: [],
            after: [{ type: 'bold' }],
        })
        const textNode = schema.text('layered', [insertMark, fcMark])
        const docNode = schema.nodes.doc.create({}, schema.nodes.paragraph.create({}, textNode))
        const state = EditorState.create({
            doc: docNode,
            schema,
            plugins: [createSuggestionDecorationsPlugin()],
        })
        const decoSet = getSuggestionDecorations(state)
        const kinds = decoSet.find().map(d => d.spec?.kind)
        expect(kinds).toContain('suggestedInsert')
        expect(kinds).toContain('suggestedFormatChange')
    })
})

describe('summarizeFormatChange', () => {
    it("describes a pure addition as 'add <mark>'", () => {
        expect(summarizeFormatChange([], [{ type: 'bold' }])).toBe('add bold')
    })

    it("describes a pure removal as 'remove <mark>'", () => {
        expect(summarizeFormatChange([{ type: 'bold' }], [])).toBe('remove bold')
    })

    it('joins multiple additions with a comma', () => {
        expect(summarizeFormatChange([], [{ type: 'bold' }, { type: 'italic' }])).toBe(
            'add bold, italic'
        )
    })

    it("describes a same-type attr swap as 'change <mark>'", () => {
        expect(
            summarizeFormatChange(
                [{ type: 'textStyle', attrs: { color: '#f00' } }],
                [{ type: 'textStyle', attrs: { color: '#0f0' } }]
            )
        ).toContain('change')
    })

    it('handles combined additions and removals', () => {
        expect(summarizeFormatChange([{ type: 'italic' }], [{ type: 'bold' }])).toContain(
            'add bold'
        )
        expect(summarizeFormatChange([{ type: 'italic' }], [{ type: 'bold' }])).toContain(
            'remove italic'
        )
    })
})
