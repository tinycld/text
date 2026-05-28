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
        // Walk ALL suggestedInsert marks per text node. The invariant
        // that matters is that two distinct sessions (separated by the
        // 30s idle window) mint two distinct suggestionIds — observable
        // across all marks on the doc. With `inclusive: false` each
        // run wears only its own session's mark, but the assertion
        // here is on the SET of ids across the whole doc, which is
        // robust regardless of how marks distribute across text nodes.
        const ids: string[] = []
        state.doc.descendants(node => {
            for (const m of node.marks) {
                if (m.type.name === 'suggestedInsert') {
                    ids.push(m.attrs.suggestionId as string)
                }
            }
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

    it('Case 2c — two users separately proposing deletion of the same range stack marks', () => {
        // Alice proposes deletion of "doomed". Then identity switches
        // to Bob, and Bob proposes deletion of the SAME range. Both
        // suggestedDelete marks should coexist on the text — the
        // schema's excludes: '' is what permits this when the command
        // layer's addMark calls run independently per author.
        const modeStore = createEditorModeStore()
        modeStore.getState().setMode(EDITOR_MODE_SUGGESTING)
        modeStore.getState().setIdentity({ userOrgId: 'uo_alice' })
        const yDoc = new Y.Doc()
        const schema = getSchema([StarterKit, ...buildSuggestionEditorExtensions()])
        const docNode = schema.nodes.doc.create(
            {},
            schema.nodes.paragraph.create({}, schema.text('doomed text'))
        )
        let state = EditorState.create({
            doc: docNode,
            schema,
            plugins: [createSuggestionCommandPlugin({ modeStore, yDoc })],
        })
        // Alice selects "doomed" and deletes
        let sel = TextSelection.create(state.doc, 1, 7)
        state = state.apply(state.tr.setSelection(sel).deleteSelection())
        // Switch to Bob
        modeStore.getState().setIdentity({ userOrgId: 'uo_bob' })
        // Wait beyond idle window so a fresh session mints — and so
        // that Bob's command-layer transaction is independent of
        // Alice's.
        vi.advanceTimersByTime(31_000)
        // Bob selects the same range (the original "doomed" text,
        // which is now wearing Alice's suggestedDelete and is still
        // in the doc per Phase 2a's restore semantics) and deletes
        sel = TextSelection.create(state.doc, 1, 7)
        state = state.apply(state.tr.setSelection(sel).deleteSelection())
        // Now the text "doomed" should carry BOTH delete marks
        let allMarksCount = 0
        let textWithBothMarks: string | null = null
        state.doc.descendants(node => {
            if (!node.isText) return
            const deletes = node.marks.filter(m => m.type.name === 'suggestedDelete')
            if (deletes.length === 2) {
                allMarksCount = 2
                textWithBothMarks = node.text ?? ''
            }
        })
        expect(allMarksCount).toBe(2)
        expect(textWithBothMarks).toBe('doomed')
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

    it('replace in suggesting mode preserves old text (struck) AND marks new text as inserted', () => {
        const modeStore = createEditorModeStore()
        modeStore.getState().setMode(EDITOR_MODE_SUGGESTING)
        modeStore.getState().setIdentity({ userOrgId: 'uo_alice' })
        const yDoc = new Y.Doc()
        let state = makeStateWithText(modeStore, yDoc, 'original text')
        // Select "original" and type "REPLACED" — a single ReplaceStep
        const sel = TextSelection.create(state.doc, 1, 9)
        state = state.apply(state.tr.setSelection(sel).insertText('REPLACED'))

        // The doc should now contain BOTH "original" (struck) and "REPLACED" (inserted)
        expect(state.doc.textContent).toContain('original')
        expect(state.doc.textContent).toContain('REPLACED')

        // And both marks should be present
        let hasInsert = false
        let hasDelete = false
        state.doc.descendants(node => {
            for (const mark of node.marks) {
                if (mark.type.name === 'suggestedInsert') hasInsert = true
                if (mark.type.name === 'suggestedDelete') hasDelete = true
            }
        })
        expect(hasInsert).toBe(true)
        expect(hasDelete).toBe(true)
    })

    it('viewing mode does not stamp marks (plugin is a no-op)', () => {
        const modeStore = createEditorModeStore()
        modeStore.getState().setMode('viewing')
        modeStore.getState().setIdentity({ userOrgId: 'uo_alice' })
        const yDoc = new Y.Doc()
        const state = makeState(modeStore, yDoc)
        // Even though the editor is "viewing", a programmatically-applied
        // transaction shouldn't crash the plugin AND shouldn't add marks.
        // (Real viewing mode also has editable: false set on the editor,
        // which prevents user-driven transactions — but the plugin alone
        // shouldn't be the only line of defense.)
        const tr = state.tr.insertText('hello', 1)
        const next = state.apply(tr)
        const marks = next.doc.firstChild?.firstChild?.marks ?? []
        expect(marks.find(m => m.type.name === 'suggestedInsert')).toBeUndefined()
    })

    it('identity change mints a fresh session for the new author', () => {
        const modeStore = createEditorModeStore()
        modeStore.getState().setMode(EDITOR_MODE_SUGGESTING)
        modeStore.getState().setIdentity({ userOrgId: 'uo_alice' })
        const yDoc = new Y.Doc()
        let state = makeState(modeStore, yDoc)

        state = state.apply(state.tr.insertText('hello', 1))
        // Walk ALL suggestedInsert marks per text node. With
        // `inclusive: false` on the mark, each author's keystrokes
        // wear only their own session's mark — Alice's run carries
        // her mark, Bob's adjacent run carries his, with no leak.
        const firstIds: { id: string; author: string }[] = []
        state.doc.descendants(node => {
            for (const m of node.marks) {
                if (m.type.name === 'suggestedInsert') {
                    firstIds.push({
                        id: m.attrs.suggestionId as string,
                        author: m.attrs.authorId as string,
                    })
                }
            }
        })
        expect(firstIds.length).toBeGreaterThan(0)
        expect(firstIds[0].author).toBe('uo_alice')

        // Switch identity to Bob
        modeStore.getState().setIdentity({ userOrgId: 'uo_bob' })
        state = state.apply(state.tr.insertText(' world', state.doc.content.size - 1))

        const allIds: { id: string; author: string }[] = []
        state.doc.descendants(node => {
            for (const m of node.marks) {
                if (m.type.name === 'suggestedInsert') {
                    allIds.push({
                        id: m.attrs.suggestionId as string,
                        author: m.attrs.authorId as string,
                    })
                }
            }
        })

        // Should have at least 2 distinct suggestion ids with different authors
        const distinctIds = new Set(allIds.map(x => x.id))
        const distinctAuthors = new Set(allIds.map(x => x.author))
        expect(distinctIds.size).toBeGreaterThanOrEqual(2)
        expect(distinctAuthors.size).toBe(2)
        expect(distinctAuthors.has('uo_alice')).toBe(true)
        expect(distinctAuthors.has('uo_bob')).toBe(true)

        // Stricter check: Alice's text segment must be credited to
        // Alice ONLY, and Bob's segment to Bob ONLY. Catches the
        // inclusive:true + excludes:'' credit-leak bug where a mark
        // carries onto the next author's adjacent keystrokes.
        const aliceRuns: string[][] = []
        const bobRuns: string[][] = []
        state.doc.descendants(node => {
            if (!node.isText) return
            const inserts = node.marks.filter(m => m.type.name === 'suggestedInsert')
            if (inserts.length === 0) return
            const authors = inserts.map(m => m.attrs.authorId as string)
            const text = node.text ?? ''
            // Each text node should carry exactly one author's mark
            // (no credit leak). Stacking is for layered marks across
            // independent command-layer transactions, not for adjacent
            // typing across authors.
            expect(authors).toHaveLength(1)
            if (authors[0] === 'uo_alice') aliceRuns.push([text, ...authors])
            else if (authors[0] === 'uo_bob') bobRuns.push([text, ...authors])
        })
        expect(aliceRuns.length).toBeGreaterThan(0)
        expect(bobRuns.length).toBeGreaterThan(0)
    })
})
