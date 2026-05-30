// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { buildSuggestionEditorExtensions } from '~/tinycld/text/lib/suggestions/build-extensions'
import { acceptSuggestion, rejectSuggestion } from '~/tinycld/text/lib/suggestions/resolve'
import { SuggestionsMap } from '~/tinycld/text/lib/suggestions/suggestions-map'
import {
    createEditorModeStore,
    EDITOR_MODE_EDITING,
    EDITOR_MODE_SUGGESTING,
} from '~/tinycld/text/stores/editor-mode-store'
import {
    SUGGESTION_STATUS_ACCEPTED,
    SUGGESTION_STATUS_REJECTED,
} from '~/tinycld/text/webview-editor/source/suggestions/suggestion-types'

describe('Phase 2a smoke', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0))
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('full flow: type in suggest mode → mark stamped → accept → mark gone', () => {
        const modeStore = createEditorModeStore()
        modeStore.getState().setIdentity({ userOrgId: 'uo_alice' })
        modeStore.getState().setMode(EDITOR_MODE_SUGGESTING)
        const yDoc = new Y.Doc()

        const editor = new Editor({
            extensions: [StarterKit, ...buildSuggestionEditorExtensions({ modeStore, yDoc })],
            content: {
                type: 'doc',
                content: [
                    {
                        type: 'paragraph',
                        content: [{ type: 'text', text: 'Original.' }],
                    },
                ],
            },
        })

        // Move cursor to the end and insert text. Use a JSON text node
        // instead of an HTML string so the insertion doesn't go through
        // the DOMParser path (which requires a window).
        editor.commands.focus('end')
        editor.commands.insertContent({ type: 'text', text: ' New text.' })

        // Verify suggestedInsert mark is present
        let foundInsert = false
        let suggestionId: string | null = null
        editor.state.doc.descendants(node => {
            const m = node.marks.find(m => m.type.name === 'suggestedInsert')
            if (m) {
                foundInsert = true
                suggestionId = m.attrs.suggestionId as string
            }
        })
        expect(foundInsert).toBe(true)
        expect(suggestionId).not.toBeNull()

        // Verify suggestions Y.Map entry was created
        const map = new SuggestionsMap(yDoc)
        const entry = map.get(suggestionId!)
        expect(entry?.authorId).toBe('uo_alice')

        // Switch to editing mode and accept
        modeStore.getState().setMode(EDITOR_MODE_EDITING)
        acceptSuggestion(editor, suggestionId!, {
            resolverUserOrgId: 'uo_carol',
            yDoc,
        })

        // Verify mark is gone, text remains
        let postAcceptInsert = false
        editor.state.doc.descendants(node => {
            if (node.marks.some(m => m.type.name === 'suggestedInsert')) postAcceptInsert = true
        })
        expect(postAcceptInsert).toBe(false)
        expect(editor.state.doc.textContent).toContain('New text.')

        // Map status updated
        expect(map.get(suggestionId!)?.status).toBe(SUGGESTION_STATUS_ACCEPTED)

        editor.destroy()
    })

    it('reject removes the inserted content entirely', () => {
        const modeStore = createEditorModeStore()
        modeStore.getState().setIdentity({ userOrgId: 'uo_alice' })
        modeStore.getState().setMode(EDITOR_MODE_SUGGESTING)
        const yDoc = new Y.Doc()

        const editor = new Editor({
            extensions: [StarterKit, ...buildSuggestionEditorExtensions({ modeStore, yDoc })],
            content: {
                type: 'doc',
                content: [
                    {
                        type: 'paragraph',
                        content: [{ type: 'text', text: 'Original.' }],
                    },
                ],
            },
        })

        editor.commands.focus('end')
        editor.commands.insertContent({ type: 'text', text: ' UNWANTED' })

        let suggestionId: string | null = null
        editor.state.doc.descendants(node => {
            const m = node.marks.find(m => m.type.name === 'suggestedInsert')
            if (m) suggestionId = m.attrs.suggestionId as string
        })

        modeStore.getState().setMode(EDITOR_MODE_EDITING)
        rejectSuggestion(editor, suggestionId!, {
            resolverUserOrgId: 'uo_carol',
            yDoc,
        })

        expect(editor.state.doc.textContent).not.toContain('UNWANTED')
        const map = new SuggestionsMap(yDoc)
        expect(map.get(suggestionId!)?.status).toBe(SUGGESTION_STATUS_REJECTED)

        editor.destroy()
    })
})
