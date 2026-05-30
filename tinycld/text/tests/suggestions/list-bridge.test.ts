// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { buildSuggestionEditorExtensions } from '~/tinycld/text/lib/suggestions/build-extensions'
import { SuggestionsMap } from '~/tinycld/text/lib/suggestions/suggestions-map'
import { computeSuggestionsForBridge } from '~/tinycld/text/webview-editor/source/suggestions/list-bridge'

describe('computeSuggestionsForBridge', () => {
    it('returns the same shape as computeDocumentSuggestions', () => {
        const yDoc = new Y.Doc()
        const editor = new Editor({
            extensions: [StarterKit, ...buildSuggestionEditorExtensions()],
            content: {
                type: 'doc',
                content: [
                    {
                        type: 'paragraph',
                        content: [
                            {
                                type: 'text',
                                text: 'foo',
                                marks: [
                                    {
                                        type: 'suggestedInsert',
                                        attrs: { suggestionId: 's1', authorId: 'uo_a', ts: 1 },
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
        })
        const map = new SuggestionsMap(yDoc)
        map.create({ id: 's1', authorId: 'uo_a', createdAt: 1 })

        const result = computeSuggestionsForBridge(editor, yDoc)
        expect(result.anchored).toHaveLength(1)
        expect(result.anchored[0].id).toBe('s1')

        editor.destroy()
    })
})
