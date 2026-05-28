// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { computeDocumentSuggestions } from '~/tinycld/text/hooks/use-document-suggestions'
import { buildSuggestionEditorExtensions } from '~/tinycld/text/lib/suggestions/build-extensions'
import { SuggestionsMap } from '~/tinycld/text/lib/suggestions/suggestions-map'

function makeEditor(content: object) {
    return new Editor({
        extensions: [StarterKit, ...buildSuggestionEditorExtensions()],
        content,
    })
}

describe('computeDocumentSuggestions', () => {
    it('returns an empty list for a doc with no suggestions', () => {
        const yDoc = new Y.Doc()
        const editor = makeEditor({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'plain' }],
                },
            ],
        })
        const map = new SuggestionsMap(yDoc)
        const result = computeDocumentSuggestions(editor.state.doc, map)
        expect(result.anchored).toHaveLength(0)
        expect(result.orphaned).toHaveLength(0)
        editor.destroy()
    })

    it('lists an anchored suggestion with snippet + range', () => {
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
                                    attrs: { suggestionId: 's1', authorId: 'uo_alice', ts: 1000 },
                                },
                            ],
                        },
                    ],
                },
            ],
        })
        const map = new SuggestionsMap(yDoc)
        map.create({ id: 's1', authorId: 'uo_alice', createdAt: 1000 })

        const result = computeDocumentSuggestions(editor.state.doc, map)
        expect(result.anchored).toHaveLength(1)
        const row = result.anchored[0]
        expect(row.id).toBe('s1')
        expect(row.kind).toBe('insert')
        expect(row.authorId).toBe('uo_alice')
        expect(row.snippet).toContain('inserted')
        expect(row.anchorRange.from).toBeGreaterThan(0)
        expect(row.anchorRange.to).toBeGreaterThan(row.anchorRange.from)
        editor.destroy()
    })

    it('sorts suggestions in document order (top to bottom)', () => {
        const yDoc = new Y.Doc()
        const editor = makeEditor({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        {
                            type: 'text',
                            text: 'second',
                            marks: [
                                {
                                    type: 'suggestedInsert',
                                    attrs: { suggestionId: 's-second', authorId: 'uo_x', ts: 2000 },
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
                            text: 'first-but-defined-later',
                            marks: [
                                {
                                    type: 'suggestedDelete',
                                    attrs: { suggestionId: 's-third', authorId: 'uo_y', ts: 3000 },
                                },
                            ],
                        },
                    ],
                },
            ],
        })
        const map = new SuggestionsMap(yDoc)
        map.create({ id: 's-second', authorId: 'uo_x', createdAt: 2000 })
        map.create({ id: 's-third', authorId: 'uo_y', createdAt: 3000 })

        const result = computeDocumentSuggestions(editor.state.doc, map)
        expect(result.anchored.map(r => r.id)).toEqual(['s-second', 's-third'])
        editor.destroy()
    })

    it('lists Y.Map entries whose marks are absent from the doc as orphaned', () => {
        const yDoc = new Y.Doc()
        const editor = makeEditor({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'just plain text' }],
                },
            ],
        })
        const map = new SuggestionsMap(yDoc)
        // Map entry exists, but no mark on the doc references it.
        map.create({ id: 's-orphan', authorId: 'uo_gone', createdAt: 500 })

        const result = computeDocumentSuggestions(editor.state.doc, map)
        expect(result.anchored).toHaveLength(0)
        expect(result.orphaned.map(r => r.id)).toEqual(['s-orphan'])
        editor.destroy()
    })

    it('layered marks (Case 2b) produce one row per suggestion', () => {
        const yDoc = new Y.Doc()
        const editor = makeEditor({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        {
                            type: 'text',
                            text: 'contested',
                            marks: [
                                {
                                    type: 'suggestedInsert',
                                    attrs: { suggestionId: 's-ins', authorId: 'uo_a', ts: 100 },
                                },
                                {
                                    type: 'suggestedDelete',
                                    attrs: { suggestionId: 's-del', authorId: 'uo_b', ts: 200 },
                                },
                            ],
                        },
                    ],
                },
            ],
        })
        const map = new SuggestionsMap(yDoc)
        map.create({ id: 's-ins', authorId: 'uo_a', createdAt: 100 })
        map.create({ id: 's-del', authorId: 'uo_b', createdAt: 200 })

        const result = computeDocumentSuggestions(editor.state.doc, map)
        expect(result.anchored).toHaveLength(2)
        expect(result.anchored.map(r => r.kind).sort()).toEqual(['delete', 'insert'])
        editor.destroy()
    })

    it('snippet is truncated at SNIPPET_MAX_LENGTH', () => {
        const long = 'x'.repeat(200)
        const yDoc = new Y.Doc()
        const editor = makeEditor({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        {
                            type: 'text',
                            text: long,
                            marks: [
                                {
                                    type: 'suggestedInsert',
                                    attrs: { suggestionId: 's-long', authorId: 'uo_z', ts: 1 },
                                },
                            ],
                        },
                    ],
                },
            ],
        })
        const map = new SuggestionsMap(yDoc)
        map.create({ id: 's-long', authorId: 'uo_z', createdAt: 1 })

        const result = computeDocumentSuggestions(editor.state.doc, map)
        expect(result.anchored[0].snippet.length).toBeLessThanOrEqual(101) // 100 chars + '…'
        expect(result.anchored[0].snippet.endsWith('…')).toBe(true)
        editor.destroy()
    })
})
