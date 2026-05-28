import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { EditorState } from 'prosemirror-state'
import { describe, expect, it } from 'vitest'
import { buildSuggestionEditorExtensions } from '~/tinycld/text/lib/suggestions/build-extensions'
import {
    createSuggestionDecorationsPlugin,
    getSuggestionDecorations,
} from '~/tinycld/text/lib/suggestions/decorations'

// Build a state with a single paragraph containing one text node whose
// marks are the ones supplied. Mirrors the command-layer test's
// makeStateWithText helper but layered for direct mark control.
function makeStateWithMarkedText(
    text: string,
    markSpecs: Array<{ name: string; attrs: Record<string, unknown> }>
) {
    const schema = getSchema([StarterKit, ...buildSuggestionEditorExtensions()])
    const marks = markSpecs.map(({ name, attrs }) => schema.marks[name].create(attrs))
    const textNode = schema.text(text, marks)
    const docNode = schema.nodes.doc.create({}, schema.nodes.paragraph.create({}, textNode))
    return EditorState.create({
        doc: docNode,
        schema,
        plugins: [createSuggestionDecorationsPlugin()],
    })
}

describe('SuggestionDecorations', () => {
    it('emits an insert decoration for a suggestedInsert mark', () => {
        const state = makeStateWithMarkedText('proposed addition', [
            {
                name: 'suggestedInsert',
                attrs: { suggestionId: 's1', authorId: 'uo_alice', ts: 1000 },
            },
        ])
        const decoSet = getSuggestionDecorations(state)
        const decos = decoSet.find()
        const insertDeco = decos.find(d => d.spec?.kind === 'suggestedInsert')
        expect(insertDeco).toBeDefined()
        expect(insertDeco?.spec?.suggestionId).toBe('s1')
    })

    it('emits a delete decoration for a suggestedDelete mark', () => {
        const state = makeStateWithMarkedText('proposed deletion', [
            {
                name: 'suggestedDelete',
                attrs: { suggestionId: 's2', authorId: 'uo_bob', ts: 2000 },
            },
        ])
        const decoSet = getSuggestionDecorations(state)
        const decos = decoSet.find()
        const deleteDeco = decos.find(d => d.spec?.kind === 'suggestedDelete')
        expect(deleteDeco).toBeDefined()
        expect(deleteDeco?.spec?.suggestionId).toBe('s2')
    })

    it('emits two decorations for layered marks (Case 2b)', () => {
        const state = makeStateWithMarkedText('contested', [
            {
                name: 'suggestedInsert',
                attrs: { suggestionId: 's-ins', authorId: 'uo_alice', ts: 1000 },
            },
            {
                name: 'suggestedDelete',
                attrs: { suggestionId: 's-del', authorId: 'uo_bob', ts: 2000 },
            },
        ])
        const decoSet = getSuggestionDecorations(state)
        const decos = decoSet.find()
        const kinds = decos.map(d => d.spec?.kind).sort()
        expect(kinds).toContain('suggestedInsert')
        expect(kinds).toContain('suggestedDelete')
    })

    it('emits no decorations for unmarked text', () => {
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
        expect(decoSet.find()).toHaveLength(0)
    })
})
