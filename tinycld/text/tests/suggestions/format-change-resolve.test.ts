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

// Phase 5 Task 5 — accept/reject for suggestedFormatChange.
//
// Accept: strip the wrapper mark, then re-apply the proposed after-set
// (with mark attrs) over the range. A "propose bold" accept lands the
// actual bold mark.
// Reject: strip the wrapper mark only. The underlying text was never
// modified (the command layer reverted the user's toggle and stamped
// the suggestion on top), so dropping the wrapper restores the
// before-state without further work.

interface SuggestionSetupOptions {
    initialMarks?: Array<{ type: string; attrs?: Record<string, unknown> }>
}

function setupEditor(opts: SuggestionSetupOptions = {}) {
    const modeStore = createEditorModeStore()
    modeStore.getState().setIdentity({ userId: 'uo_alice' })
    modeStore.getState().setMode(EDITOR_MODE_SUGGESTING)
    const yDoc = new Y.Doc()
    const editor = new Editor({
        extensions: [StarterKit, ...buildSuggestionEditorExtensions({ modeStore, yDoc })],
        content: {
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        {
                            type: 'text',
                            text: 'hello',
                            marks: opts.initialMarks,
                        },
                        { type: 'text', text: ' world' },
                    ],
                },
            ],
        },
    })
    return { editor, yDoc, modeStore }
}

function findFormatChangeId(editor: Editor): string | null {
    let id: string | null = null
    editor.state.doc.descendants(node => {
        if (!node.isText) return true
        for (const m of node.marks) {
            if (m.type.name === 'suggestedFormatChange' && !id) {
                id = m.attrs.suggestionId as string
            }
        }
        return true
    })
    return id
}

function hasMarkInRange(
    editor: Editor,
    markName: string,
    from: number,
    to: number,
    attrPredicate?: (attrs: Record<string, unknown>) => boolean
): boolean {
    let found = false
    editor.state.doc.descendants((node, pos) => {
        if (!node.isText) return true
        const overlaps = pos < to && pos + node.nodeSize > from
        if (!overlaps) return true
        for (const m of node.marks) {
            if (m.type.name !== markName) continue
            if (attrPredicate && !attrPredicate(m.attrs)) continue
            found = true
        }
        return true
    })
    return found
}

describe('acceptSuggestion (suggestedFormatChange)', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0))
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('strips the wrapper and applies the proposed after-set (add bold)', () => {
        const { editor, yDoc, modeStore } = setupEditor()
        editor.commands.setTextSelection({ from: 1, to: 6 })
        editor.commands.toggleBold()
        const id = findFormatChangeId(editor)
        expect(id).not.toBeNull()
        const suggestionId = id as unknown as string

        // Switch out of suggesting mode so resolution writes aren't
        // re-intercepted by the command layer.
        modeStore.getState().setMode(EDITOR_MODE_EDITING)

        acceptSuggestion(editor, suggestionId, {
            resolverUserId: 'uo_carol',
            yDoc,
        })

        // The wrapper mark is gone.
        let hasFormatChange = false
        editor.state.doc.descendants(node => {
            if (node.marks.some(m => m.type.name === 'suggestedFormatChange')) {
                hasFormatChange = true
            }
        })
        expect(hasFormatChange).toBe(false)
        // The proposed bold mark is now applied over the original range.
        expect(hasMarkInRange(editor, 'bold', 1, 6)).toBe(true)
        const map = new SuggestionsMap(yDoc)
        expect(map.get(suggestionId)?.status).toBe(SUGGESTION_STATUS_ACCEPTED)
        editor.destroy()
    })

    it('applies multiple marks in the after-set (bold + italic)', () => {
        const { editor, yDoc, modeStore } = setupEditor()
        // Two toggles inside the session idle window share one
        // suggestionId; after-set should capture both.
        editor.commands.setTextSelection({ from: 1, to: 6 })
        editor.commands.toggleBold()
        vi.advanceTimersByTime(200)
        editor.commands.setTextSelection({ from: 1, to: 6 })
        editor.commands.toggleItalic()
        const id = findFormatChangeId(editor)
        expect(id).not.toBeNull()
        const suggestionId = id as unknown as string

        modeStore.getState().setMode(EDITOR_MODE_EDITING)
        acceptSuggestion(editor, suggestionId, {
            resolverUserId: 'uo_carol',
            yDoc,
        })

        expect(hasMarkInRange(editor, 'bold', 1, 6)).toBe(true)
        expect(hasMarkInRange(editor, 'italic', 1, 6)).toBe(true)
        editor.destroy()
    })

    it('removes bold when before=[bold] and after=[] (proposed mark removal)', () => {
        // Author proposes to REMOVE bold from already-bold text.
        // Accept should actually remove the bold mark.
        const { editor, yDoc, modeStore } = setupEditor({
            initialMarks: [{ type: 'bold' }],
        })
        editor.commands.setTextSelection({ from: 1, to: 6 })
        editor.commands.toggleBold()
        const id = findFormatChangeId(editor)
        expect(id).not.toBeNull()
        const suggestionId = id as unknown as string

        // While in suggesting mode the bold is still on the run (the
        // command layer reverted the user's removal).
        expect(hasMarkInRange(editor, 'bold', 1, 6)).toBe(true)

        modeStore.getState().setMode(EDITOR_MODE_EDITING)
        acceptSuggestion(editor, suggestionId, {
            resolverUserId: 'uo_carol',
            yDoc,
        })

        // After accept: wrapper gone and bold removed.
        let hasFormatChange = false
        editor.state.doc.descendants(node => {
            if (node.marks.some(m => m.type.name === 'suggestedFormatChange')) {
                hasFormatChange = true
            }
        })
        expect(hasFormatChange).toBe(false)
        expect(hasMarkInRange(editor, 'bold', 1, 6)).toBe(false)
        editor.destroy()
    })
})

describe('rejectSuggestion (suggestedFormatChange)', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0))
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('strips the wrapper without applying any new marks (reject add bold)', () => {
        const { editor, yDoc, modeStore } = setupEditor()
        editor.commands.setTextSelection({ from: 1, to: 6 })
        editor.commands.toggleBold()
        const id = findFormatChangeId(editor)
        const suggestionId = id as unknown as string

        modeStore.getState().setMode(EDITOR_MODE_EDITING)
        rejectSuggestion(editor, suggestionId, {
            resolverUserId: 'uo_carol',
            yDoc,
        })

        // Wrapper gone, and no bold mark was added.
        let hasFormatChange = false
        editor.state.doc.descendants(node => {
            if (node.marks.some(m => m.type.name === 'suggestedFormatChange')) {
                hasFormatChange = true
            }
        })
        expect(hasFormatChange).toBe(false)
        expect(hasMarkInRange(editor, 'bold', 1, 6)).toBe(false)
        const map = new SuggestionsMap(yDoc)
        expect(map.get(suggestionId)?.status).toBe(SUGGESTION_STATUS_REJECTED)
        editor.destroy()
    })

    it('leaves bold in place when before=[bold] and after=[] (reject mark removal)', () => {
        const { editor, yDoc, modeStore } = setupEditor({
            initialMarks: [{ type: 'bold' }],
        })
        editor.commands.setTextSelection({ from: 1, to: 6 })
        editor.commands.toggleBold()
        const id = findFormatChangeId(editor)
        const suggestionId = id as unknown as string

        modeStore.getState().setMode(EDITOR_MODE_EDITING)
        rejectSuggestion(editor, suggestionId, {
            resolverUserId: 'uo_carol',
            yDoc,
        })

        // Wrapper gone and bold stays.
        let hasFormatChange = false
        editor.state.doc.descendants(node => {
            if (node.marks.some(m => m.type.name === 'suggestedFormatChange')) {
                hasFormatChange = true
            }
        })
        expect(hasFormatChange).toBe(false)
        expect(hasMarkInRange(editor, 'bold', 1, 6)).toBe(true)
        editor.destroy()
    })
})
