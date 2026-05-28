// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
    createNativeSuggestionBridge,
    type NativeSuggestionBridge,
} from '~/tinycld/text/hooks/use-suggestion-bridge.native'
import { createWebSuggestionBridge } from '~/tinycld/text/hooks/use-suggestion-bridge.web'
import { buildSuggestionEditorExtensions } from '~/tinycld/text/lib/suggestions/build-extensions'
import { SuggestionsMap } from '~/tinycld/text/lib/suggestions/suggestions-map'

describe('Phase 2c smoke — bridge platform parity', () => {
    it('web and native bridges produce the same anchored shape', () => {
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
                                text: 'proposed',
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

        // Web: reads the editor directly
        const webBridge = createWebSuggestionBridge({
            driveItemId: 'di_x',
            yDoc,
            editor,
        })

        // Native: receives a posted snapshot from the WebView
        const nativeBridge: NativeSuggestionBridge = createNativeSuggestionBridge({
            driveItemId: 'di_x',
            yDoc: null,
            editor: null,
        })
        // Simulate the WebView pushing the snapshot
        nativeBridge.processIncomingMessage('suggestion.changed', {
            driveItemId: 'di_x',
            result: webBridge.getSnapshot(),
        })

        const webSnap = webBridge.getSnapshot()
        const nativeSnap = nativeBridge.getSnapshot()
        expect(nativeSnap.anchored).toHaveLength(webSnap.anchored.length)
        expect(nativeSnap.anchored[0]?.id).toBe(webSnap.anchored[0]?.id)
        expect(nativeSnap.anchored[0]?.snippet).toBe(webSnap.anchored[0]?.snippet)

        editor.destroy()
    })
})
