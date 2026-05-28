import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { EditorState, TextSelection } from 'prosemirror-state'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { buildSuggestionEditorExtensions } from '~/tinycld/text/lib/suggestions/build-extensions'
import { createSuggestionCommandPlugin } from '~/tinycld/text/lib/suggestions/command-layer'
import {
    createEditorModeStore,
    EDITOR_MODE_EDITING,
    EDITOR_MODE_SUGGESTING,
} from '~/tinycld/text/stores/editor-mode-store'

function makeState(modeStore: ReturnType<typeof createEditorModeStore>, yDoc: Y.Doc) {
    const schema = getSchema([StarterKit, ...buildSuggestionEditorExtensions()])
    return EditorState.create({
        schema,
        plugins: [createSuggestionCommandPlugin({ modeStore, yDoc })],
    })
}

function makeStateWithText(
    modeStore: ReturnType<typeof createEditorModeStore>,
    yDoc: Y.Doc,
    text: string
) {
    const schema = getSchema([StarterKit, ...buildSuggestionEditorExtensions()])
    const docNode = schema.nodes.doc.create(
        {},
        schema.nodes.paragraph.create({}, schema.text(text))
    )
    return EditorState.create({
        doc: docNode,
        schema,
        plugins: [createSuggestionCommandPlugin({ modeStore, yDoc })],
    })
}

describe('SuggestionCommandLayer', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0))
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('insert in editing mode does not stamp suggestedInsert mark', () => {
        const modeStore = createEditorModeStore()
        modeStore.getState().setMode(EDITOR_MODE_EDITING)
        modeStore.getState().setIdentity({ userOrgId: 'uo_alice' })
        const yDoc = new Y.Doc()
        const state = makeState(modeStore, yDoc)
        const tr = state.tr.insertText('hello', 1)
        const next = state.apply(tr)
        const marks = next.doc.firstChild?.firstChild?.marks ?? []
        expect(marks.find(m => m.type.name === 'suggestedInsert')).toBeUndefined()
    })

    it('insert in suggesting mode stamps suggestedInsert with the active session id', () => {
        const modeStore = createEditorModeStore()
        modeStore.getState().setMode(EDITOR_MODE_SUGGESTING)
        modeStore.getState().setIdentity({ userOrgId: 'uo_alice' })
        const yDoc = new Y.Doc()
        const state = makeState(modeStore, yDoc)
        const tr = state.tr.insertText('hello', 1)
        const next = state.apply(tr)
        const text = next.doc.firstChild?.firstChild
        const mark = text?.marks.find(m => m.type.name === 'suggestedInsert')
        expect(mark).toBeDefined()
        expect(mark?.attrs.authorId).toBe('uo_alice')
        expect(typeof mark?.attrs.suggestionId).toBe('string')
        expect(mark?.attrs.ts).toBeGreaterThan(0)
    })

    it('two rapid inserts in suggesting mode share one suggestionId', () => {
        const modeStore = createEditorModeStore()
        modeStore.getState().setMode(EDITOR_MODE_SUGGESTING)
        modeStore.getState().setIdentity({ userOrgId: 'uo_alice' })
        const yDoc = new Y.Doc()
        let state = makeState(modeStore, yDoc)
        state = state.apply(state.tr.insertText('hello', 1))
        vi.advanceTimersByTime(100)
        state = state.apply(state.tr.insertText(' world', state.doc.content.size - 1))
        const ids: string[] = []
        state.doc.descendants(node => {
            const m = node.marks.find(m => m.type.name === 'suggestedInsert')
            if (m) ids.push(m.attrs.suggestionId as string)
        })
        expect(ids.length).toBeGreaterThan(0)
        expect(new Set(ids).size).toBe(1)
    })

    it('inserts 31s apart in suggesting mode get different suggestionIds', () => {
        const modeStore = createEditorModeStore()
        modeStore.getState().setMode(EDITOR_MODE_SUGGESTING)
        modeStore.getState().setIdentity({ userOrgId: 'uo_alice' })
        const yDoc = new Y.Doc()
        let state = makeState(modeStore, yDoc)
        state = state.apply(state.tr.insertText('hello', 1))
        vi.advanceTimersByTime(31_000)
        state = state.apply(state.tr.insertText(' world', state.doc.content.size - 1))
        const ids: string[] = []
        state.doc.descendants(node => {
            const m = node.marks.find(m => m.type.name === 'suggestedInsert')
            if (m) ids.push(m.attrs.suggestionId as string)
        })
        expect(new Set(ids).size).toBe(2)
    })

    it('delete in suggesting mode wraps the range in suggestedDelete without removing text', () => {
        const modeStore = createEditorModeStore()
        modeStore.getState().setMode(EDITOR_MODE_SUGGESTING)
        modeStore.getState().setIdentity({ userOrgId: 'uo_alice' })
        const yDoc = new Y.Doc()
        let state = makeStateWithText(modeStore, yDoc, 'original text')
        const sel = TextSelection.create(state.doc, 1, 9)
        state = state.apply(state.tr.setSelection(sel).deleteSelection())
        expect(state.doc.textContent).toContain('original')
        // Find the suggestedDelete mark anywhere in the doc.
        let foundMark = false
        state.doc.descendants(node => {
            if (node.marks.find(m => m.type.name === 'suggestedDelete')) {
                foundMark = true
            }
        })
        expect(foundMark).toBe(true)
    })

    it('delete in editing mode removes text as normal (no mark)', () => {
        const modeStore = createEditorModeStore()
        modeStore.getState().setMode(EDITOR_MODE_EDITING)
        modeStore.getState().setIdentity({ userOrgId: 'uo_alice' })
        const yDoc = new Y.Doc()
        let state = makeStateWithText(modeStore, yDoc, 'original text')
        const sel = TextSelection.create(state.doc, 1, 9)
        state = state.apply(state.tr.setSelection(sel).deleteSelection())
        expect(state.doc.textContent).not.toContain('original')
    })

    it('delete of own active-suggestion content (Case 2d) removes outright', () => {
        const modeStore = createEditorModeStore()
        modeStore.getState().setMode(EDITOR_MODE_SUGGESTING)
        modeStore.getState().setIdentity({ userOrgId: 'uo_alice' })
        const yDoc = new Y.Doc()
        let state = makeState(modeStore, yDoc)
        state = state.apply(state.tr.insertText('hello', 1))
        // Now select that "hello" and delete — should remove outright
        const sel = TextSelection.create(state.doc, 1, 6)
        state = state.apply(state.tr.setSelection(sel).deleteSelection())
        expect(state.doc.textContent).not.toContain('hello')
    })

    it('creates a suggestions map entry on first edit in suggest mode', () => {
        const modeStore = createEditorModeStore()
        modeStore.getState().setMode(EDITOR_MODE_SUGGESTING)
        modeStore.getState().setIdentity({ userOrgId: 'uo_alice' })
        const yDoc = new Y.Doc()
        const state = makeState(modeStore, yDoc)
        state.apply(state.tr.insertText('hello', 1))
        // After the apply, the suggestions map should have one entry
        const map = yDoc.getMap('suggestions')
        expect(map.size).toBeGreaterThan(0)
    })
})
