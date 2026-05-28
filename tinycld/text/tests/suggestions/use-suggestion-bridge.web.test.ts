// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { buildSuggestionEditorExtensions } from '~/tinycld/text/lib/suggestions/build-extensions'
import { createWebSuggestionBridge } from '~/tinycld/text/hooks/use-suggestion-bridge.web'
import { SuggestionsMap } from '~/tinycld/text/lib/suggestions/suggestions-map'

describe('web suggestion bridge', () => {
    it('getSnapshot returns the current anchored + orphaned suggestions', () => {
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
                                        attrs: { suggestionId: 's1', authorId: 'uo_alice', ts: 1000 },
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
        })
        const map = new SuggestionsMap(yDoc)
        map.create({ id: 's1', authorId: 'uo_alice', createdAt: 1000 })

        const bridge = createWebSuggestionBridge({ driveItemId: 'di_x', yDoc, editor })
        const snap = bridge.getSnapshot()
        expect(snap.anchored).toHaveLength(1)
        expect(snap.anchored[0].id).toBe('s1')
        editor.destroy()
    })

    it('subscribe handler fires on editor transactions', () => {
        const yDoc = new Y.Doc()
        const editor = new Editor({
            extensions: [StarterKit, ...buildSuggestionEditorExtensions()],
            content: '<p>x</p>',
        })
        const bridge = createWebSuggestionBridge({ driveItemId: 'di_x', yDoc, editor })

        let fired = 0
        const unsub = bridge.subscribe(() => {
            fired++
        })

        editor.commands.focus('end')
        editor.commands.insertContent({ type: 'text', text: 'more' })

        expect(fired).toBeGreaterThan(0)

        unsub()
        editor.destroy()
    })

    it('subscribe handler stops firing after unsubscribe', () => {
        const yDoc = new Y.Doc()
        const editor = new Editor({
            extensions: [StarterKit, ...buildSuggestionEditorExtensions()],
            content: '<p>x</p>',
        })
        const bridge = createWebSuggestionBridge({ driveItemId: 'di_x', yDoc, editor })

        let fired = 0
        const unsub = bridge.subscribe(() => {
            fired++
        })
        unsub()
        editor.commands.focus('end')
        editor.commands.insertContent({ type: 'text', text: 'more' })

        expect(fired).toBe(0)
        editor.destroy()
    })

    it('null editor returns an empty snapshot', () => {
        const yDoc = new Y.Doc()
        const bridge = createWebSuggestionBridge({ driveItemId: 'di_x', yDoc, editor: null })
        const snap = bridge.getSnapshot()
        expect(snap.anchored).toEqual([])
        expect(snap.orphaned).toEqual([])
    })

    it('null yDoc returns an empty snapshot', () => {
        const editor = new Editor({
            extensions: [StarterKit, ...buildSuggestionEditorExtensions()],
            content: '<p>x</p>',
        })
        const bridge = createWebSuggestionBridge({ driveItemId: 'di_x', yDoc: null, editor })
        const snap = bridge.getSnapshot()
        expect(snap.anchored).toEqual([])
        expect(snap.orphaned).toEqual([])
        editor.destroy()
    })
})
