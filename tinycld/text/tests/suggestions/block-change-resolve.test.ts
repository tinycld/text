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

// Phase 5 Task 9 — accept/reject for suggestedBlockChange. Each test
// creates a suggesting-mode editor, runs a block-level change (so the
// command-layer stamps a suggestedBlockChange entry), switches to
// editing mode (so resolve writes aren't re-intercepted), and exercises
// either acceptSuggestion or rejectSuggestion.

interface BlockChangePayload {
    suggestionId: string
    before: { type: string; attrs: Record<string, unknown> }
    after: { type: string; attrs: Record<string, unknown>; deleted?: boolean }
}

function setupEditor(content: object) {
    const modeStore = createEditorModeStore()
    modeStore.getState().setIdentity({ userOrgId: 'uo_alice' })
    modeStore.getState().setMode(EDITOR_MODE_SUGGESTING)
    const yDoc = new Y.Doc()
    const editor = new Editor({
        extensions: [StarterKit, ...buildSuggestionEditorExtensions({ modeStore, yDoc })],
        content,
    })
    return { editor, yDoc, modeStore }
}

function findBlockChangeId(editor: Editor): string | null {
    let id: string | null = null
    editor.state.doc.descendants(node => {
        if (id) return false
        const v = node.attrs.suggestedBlockChange as BlockChangePayload | null
        if (v) id = v.suggestionId
        return true
    })
    return id
}

function blockHasSuggestedBlockChange(editor: Editor): boolean {
    let found = false
    editor.state.doc.descendants(node => {
        if (node.attrs.suggestedBlockChange) found = true
        return true
    })
    return found
}

function blockTypeAndAttr(editor: Editor): { type: string; attrs: Record<string, unknown> } | null {
    let result: { type: string; attrs: Record<string, unknown> } | null = null
    editor.state.doc.descendants(node => {
        if (result) return false
        if (node.type.name === 'paragraph' || node.type.name === 'heading') {
            result = { type: node.type.name, attrs: { ...node.attrs } }
        }
        return true
    })
    return result
}

describe('acceptSuggestion (suggestedBlockChange)', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0))
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('attr-only change: accept applies after.attrs and clears the wrapper', () => {
        const { editor, yDoc, modeStore } = setupEditor({
            type: 'doc',
            content: [
                {
                    type: 'heading',
                    attrs: { level: 1 },
                    content: [{ type: 'text', text: 'title' }],
                },
            ],
        })

        // Propose a level change 1 → 3.
        editor.commands.command(({ tr, dispatch }) => {
            tr.setNodeAttribute(0, 'level', 3)
            dispatch?.(tr)
            return true
        })
        const id = findBlockChangeId(editor) as string
        expect(id).not.toBeNull()
        // Currently the heading is still level 1 (the user's change
        // was reverted by the command layer).
        expect(blockTypeAndAttr(editor)?.attrs.level).toBe(1)

        modeStore.getState().setMode(EDITOR_MODE_EDITING)
        acceptSuggestion(editor, id, { resolverUserOrgId: 'uo_carol', yDoc })

        // After accept: level is 3, wrapper is gone.
        const after = blockTypeAndAttr(editor)
        expect(after?.type).toBe('heading')
        expect(after?.attrs.level).toBe(3)
        expect(blockHasSuggestedBlockChange(editor)).toBe(false)
        const map = new SuggestionsMap(yDoc)
        expect(map.get(id)?.status).toBe(SUGGESTION_STATUS_ACCEPTED)
        editor.destroy()
    })

    it('attr-only change: reject leaves the block in before-state and clears the wrapper', () => {
        const { editor, yDoc, modeStore } = setupEditor({
            type: 'doc',
            content: [
                {
                    type: 'heading',
                    attrs: { level: 1 },
                    content: [{ type: 'text', text: 'title' }],
                },
            ],
        })

        editor.commands.command(({ tr, dispatch }) => {
            tr.setNodeAttribute(0, 'level', 3)
            dispatch?.(tr)
            return true
        })
        const id = findBlockChangeId(editor) as string

        modeStore.getState().setMode(EDITOR_MODE_EDITING)
        rejectSuggestion(editor, id, { resolverUserOrgId: 'uo_carol', yDoc })

        const after = blockTypeAndAttr(editor)
        // Level still 1, wrapper gone.
        expect(after?.type).toBe('heading')
        expect(after?.attrs.level).toBe(1)
        expect(blockHasSuggestedBlockChange(editor)).toBe(false)
        const map = new SuggestionsMap(yDoc)
        expect(map.get(id)?.status).toBe(SUGGESTION_STATUS_REJECTED)
        editor.destroy()
    })

    it('type-swap: accept transforms paragraph → heading', () => {
        const { editor, yDoc, modeStore } = setupEditor({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'hello' }],
                },
            ],
        })

        editor.commands.setTextSelection({ from: 1, to: 5 })
        editor.commands.setHeading({ level: 2 })
        const id = findBlockChangeId(editor) as string
        // Before resolve: block is still a paragraph.
        expect(blockTypeAndAttr(editor)?.type).toBe('paragraph')

        modeStore.getState().setMode(EDITOR_MODE_EDITING)
        acceptSuggestion(editor, id, { resolverUserOrgId: 'uo_carol', yDoc })

        const after = blockTypeAndAttr(editor)
        expect(after?.type).toBe('heading')
        expect(after?.attrs.level).toBe(2)
        expect(blockHasSuggestedBlockChange(editor)).toBe(false)
        editor.destroy()
    })

    it('type-swap: reject leaves the block as paragraph and clears the wrapper', () => {
        const { editor, yDoc, modeStore } = setupEditor({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'hello' }],
                },
            ],
        })

        editor.commands.setTextSelection({ from: 1, to: 5 })
        editor.commands.setHeading({ level: 2 })
        const id = findBlockChangeId(editor) as string

        modeStore.getState().setMode(EDITOR_MODE_EDITING)
        rejectSuggestion(editor, id, { resolverUserOrgId: 'uo_carol', yDoc })

        const after = blockTypeAndAttr(editor)
        expect(after?.type).toBe('paragraph')
        expect(blockHasSuggestedBlockChange(editor)).toBe(false)
        editor.destroy()
    })

    it('delete: accept removes the block from the doc', () => {
        const { editor, yDoc, modeStore } = setupEditor({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'alpha' }],
                },
                {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'beta' }],
                },
            ],
        })

        // Propose deletion of the first paragraph [0, 7).
        editor.commands.command(({ tr, dispatch }) => {
            tr.delete(0, 7)
            dispatch?.(tr)
            return true
        })
        const id = findBlockChangeId(editor) as string
        // Before resolve: both paragraphs still present.
        expect(editor.state.doc.childCount).toBe(2)
        expect(editor.state.doc.firstChild?.textContent).toBe('alpha')

        modeStore.getState().setMode(EDITOR_MODE_EDITING)
        acceptSuggestion(editor, id, { resolverUserOrgId: 'uo_carol', yDoc })

        // After accept: alpha is gone, only beta remains.
        expect(editor.state.doc.childCount).toBe(1)
        expect(editor.state.doc.firstChild?.textContent).toBe('beta')
        expect(blockHasSuggestedBlockChange(editor)).toBe(false)
        editor.destroy()
    })

    it('delete: reject restores the block and strips suggestedDelete marks from its content', () => {
        const { editor, yDoc, modeStore } = setupEditor({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'alpha' }],
                },
                {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'beta' }],
                },
            ],
        })

        editor.commands.command(({ tr, dispatch }) => {
            tr.delete(0, 7)
            dispatch?.(tr)
            return true
        })
        const id = findBlockChangeId(editor) as string
        // Sanity: the block exists with a suggestedDelete mark on its
        // inline content.
        let hadDeleteMark = false
        editor.state.doc.descendants(node => {
            if (!node.isText) return true
            for (const m of node.marks) {
                if (m.type.name === 'suggestedDelete' && m.attrs.suggestionId === id) {
                    hadDeleteMark = true
                }
            }
            return true
        })
        expect(hadDeleteMark).toBe(true)

        modeStore.getState().setMode(EDITOR_MODE_EDITING)
        rejectSuggestion(editor, id, { resolverUserOrgId: 'uo_carol', yDoc })

        // After reject: alpha is back without strikethrough, both
        // paragraphs present.
        expect(editor.state.doc.childCount).toBe(2)
        expect(editor.state.doc.firstChild?.textContent).toBe('alpha')
        expect(blockHasSuggestedBlockChange(editor)).toBe(false)
        // No suggestedDelete marks remain.
        let stillHasDeleteMark = false
        editor.state.doc.descendants(node => {
            if (!node.isText) return true
            for (const m of node.marks) {
                if (m.type.name === 'suggestedDelete' && m.attrs.suggestionId === id) {
                    stillHasDeleteMark = true
                }
            }
            return true
        })
        expect(stillHasDeleteMark).toBe(false)
        editor.destroy()
    })
})
