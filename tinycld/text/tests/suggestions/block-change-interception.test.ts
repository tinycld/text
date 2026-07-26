// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { buildSuggestionEditorExtensions } from '~/tinycld/text/lib/suggestions/build-extensions'
import { SuggestionsMap } from '~/tinycld/text/lib/suggestions/suggestions-map'
import {
    createEditorModeStore,
    EDITOR_MODE_SUGGESTING,
} from '~/tinycld/text/stores/editor-mode-store'

// Phase 5 integration: when the user is in suggesting mode and runs a
// block-level command (setBlockType / setNodeAttribute / block delete),
// the command layer must intercept and replace the raw structural
// change with a suggestedBlockChange node attribute. The visible block
// must NOT undergo the type/attr change — the resolve path is what
// applies the proposal on accept.

interface BlockChangePayload {
    suggestionId: string
    authorId: string
    ts: number
    before: { type: string; attrs: Record<string, unknown> }
    after: { type: string; attrs: Record<string, unknown>; deleted?: boolean }
}

function setupSuggestingEditor(content: object) {
    const modeStore = createEditorModeStore()
    modeStore.getState().setIdentity({ userId: 'uo_alice' })
    modeStore.getState().setMode(EDITOR_MODE_SUGGESTING)
    const yDoc = new Y.Doc()
    const editor = new Editor({
        extensions: [StarterKit, ...buildSuggestionEditorExtensions({ modeStore, yDoc })],
        content,
    })
    return { editor, yDoc, modeStore }
}

function collectBlockChanges(editor: Editor): Array<{
    nodeType: string
    pos: number
    payload: BlockChangePayload
}> {
    const out: Array<{ nodeType: string; pos: number; payload: BlockChangePayload }> = []
    editor.state.doc.descendants((node, pos) => {
        const v = node.attrs.suggestedBlockChange as BlockChangePayload | null
        if (v) {
            out.push({ nodeType: node.type.name, pos, payload: v })
        }
        return true
    })
    return out
}

describe('Phase 5 block-change interception', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0))
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it("setBlockType('heading', {level: 2}) in suggesting mode records suggestedBlockChange without changing the block type", () => {
        const { editor, yDoc } = setupSuggestingEditor({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'hello world' }],
                },
            ],
        })

        // Select inside the paragraph and toggle a heading.
        editor.commands.setTextSelection({ from: 1, to: 6 })
        editor.commands.setHeading({ level: 2 })

        const entries = collectBlockChanges(editor)
        expect(entries).toHaveLength(1)
        const { nodeType, payload } = entries[0]
        // The block STILL renders as a paragraph — the type swap was
        // reverted and replaced with a pending suggestion.
        expect(nodeType).toBe('paragraph')
        expect(payload.before.type).toBe('paragraph')
        expect(payload.after.type).toBe('heading')
        expect(payload.after.attrs.level).toBe(2)
        expect(payload.suggestionId.length).toBeGreaterThan(0)
        expect(payload.authorId).toBe('uo_alice')

        // SuggestionsMap entry is created so the resolver can find it.
        const map = new SuggestionsMap(yDoc)
        const entry = map.get(payload.suggestionId)
        expect(entry?.authorId).toBe('uo_alice')

        editor.destroy()
    })

    it('setNodeAttribute in suggesting mode records suggestedBlockChange without applying the attr', () => {
        const { editor } = setupSuggestingEditor({
            type: 'doc',
            content: [
                {
                    type: 'heading',
                    attrs: { level: 1 },
                    content: [{ type: 'text', text: 'title' }],
                },
            ],
        })

        // Change the heading level from 1 to 3 via setNodeAttribute on
        // the heading at pos 0.
        editor.commands.command(({ tr, dispatch }) => {
            tr.setNodeAttribute(0, 'level', 3)
            dispatch?.(tr)
            return true
        })

        const entries = collectBlockChanges(editor)
        expect(entries).toHaveLength(1)
        const { nodeType, payload } = entries[0]
        // The heading is still at level 1.
        expect(nodeType).toBe('heading')
        expect(editor.state.doc.firstChild?.attrs.level).toBe(1)
        expect(payload.before.type).toBe('heading')
        expect(payload.before.attrs.level).toBe(1)
        expect(payload.after.type).toBe('heading')
        expect(payload.after.attrs.level).toBe(3)
        editor.destroy()
    })

    it('deleting a full paragraph in suggesting mode preserves the block and marks its content suggestedDelete', () => {
        const { editor } = setupSuggestingEditor({
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

        // Doc positions:
        //   pos 0 : <p>alpha</p>  (size 7)
        //   pos 7 : <p>beta</p>   (size 6)
        // Delete the first paragraph entirely [0, 7).
        editor.commands.command(({ tr, dispatch }) => {
            tr.delete(0, 7)
            dispatch?.(tr)
            return true
        })

        // The paragraph should STILL exist in the doc (we restored it).
        const firstBlock = editor.state.doc.firstChild
        expect(firstBlock?.type.name).toBe('paragraph')
        expect(firstBlock?.textContent).toBe('alpha')

        // Its suggestedBlockChange attribute carries deleted:true.
        const entries = collectBlockChanges(editor)
        expect(entries.length).toBeGreaterThan(0)
        const deletedEntry = entries.find(e => e.payload.after.deleted === true)
        expect(deletedEntry).toBeDefined()
        expect(deletedEntry?.payload.before.type).toBe('paragraph')

        // All inline text inside the restored block carries a
        // suggestedDelete mark with the same suggestionId.
        const suggestionId = deletedEntry?.payload.suggestionId as string
        let hasDeleteMark = false
        editor.state.doc.descendants(node => {
            if (!node.isText) return true
            for (const m of node.marks) {
                if (m.type.name === 'suggestedDelete' && m.attrs.suggestionId === suggestionId) {
                    hasDeleteMark = true
                }
            }
            return true
        })
        expect(hasDeleteMark).toBe(true)
        editor.destroy()
    })

    it('two block changes within the session window share one suggestionId', () => {
        const { editor } = setupSuggestingEditor({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'first' }],
                },
                {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'second' }],
                },
            ],
        })

        // First block change.
        editor.commands.setTextSelection({ from: 1, to: 6 })
        editor.commands.setHeading({ level: 2 })
        vi.advanceTimersByTime(200)
        // Second block change on the second block. The second paragraph
        // starts at position 7 (after the first paragraph's 7-size).
        editor.commands.setTextSelection({ from: 8, to: 14 })
        editor.commands.setHeading({ level: 3 })

        const entries = collectBlockChanges(editor)
        const ids = new Set(entries.map(e => e.payload.suggestionId))
        expect(ids.size).toBe(1)
        expect(entries).toHaveLength(2)
        editor.destroy()
    })
})
