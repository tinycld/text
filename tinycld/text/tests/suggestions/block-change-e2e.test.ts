// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import TextAlign from '@tiptap/extension-text-align'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { buildSuggestionEditorExtensions } from '~/tinycld/text/lib/suggestions/build-extensions'
import { acceptSuggestion, rejectSuggestion } from '~/tinycld/text/lib/suggestions/resolve'
import {
    createEditorModeStore,
    EDITOR_MODE_EDITING,
    EDITOR_MODE_SUGGESTING,
} from '~/tinycld/text/stores/editor-mode-store'

// Task 11 integration tests — full TipTap editor under suggesting mode
// exercising the block-change pipeline end to end. Each test:
//
//   1. Builds a suggesting-mode editor with a known authorId.
//   2. Runs an actual editor command (setHeading, setTextAlign,
//      deleteSelection) the way real code paths do.
//   3. Asserts the doc shape after interception: the visible block is
//      unchanged, the suggestedBlockChange attribute carries the
//      proposal, the suggestionId is registered in the map.
//   4. Resolves (accept or reject) and asserts the doc collapses to
//      the expected post-resolution shape.
//
// These exercise the full pipeline: command-layer interception →
// block-change-utils detection → SuggestedBlockChange attribute →
// SuggestionsMap entry → resolve.ts accept/reject. Phase 2c-stacking
// and format-change interactions are covered separately.

interface BlockChangePayload {
    suggestionId: string
    authorId: string
    ts: number
    before: { type: string; attrs: Record<string, unknown> }
    after: { type: string; attrs: Record<string, unknown>; deleted?: boolean }
}

// setupEditor builds a TipTap editor wired with StarterKit, TextAlign
// (for the alignment test), and the suggestion extensions. The default
// mode is suggesting — tests that need editing mode (e.g. the
// "editing mode unchanged" test) override before any commands run.
//
// TextAlign is included because real editor mounts include it (see
// webview-editor/source/Editor.tsx) — adding it here mirrors the
// production schema rather than a leaner test-only schema.
function setupEditor(opts: {
    content: object
    mode?: typeof EDITOR_MODE_SUGGESTING | typeof EDITOR_MODE_EDITING
    authorId?: string
}) {
    const modeStore = createEditorModeStore()
    modeStore.getState().setIdentity({ userId: opts.authorId ?? 'uo_alice' })
    modeStore.getState().setMode(opts.mode ?? EDITOR_MODE_SUGGESTING)
    const yDoc = new Y.Doc()
    const editor = new Editor({
        extensions: [
            StarterKit,
            TextAlign.configure({
                types: ['paragraph', 'heading'],
                alignments: ['left', 'center', 'right', 'justify'],
                defaultAlignment: null,
            }),
            ...buildSuggestionEditorExtensions({ modeStore, yDoc }),
        ],
        content: opts.content,
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
        if (v) out.push({ nodeType: node.type.name, pos, payload: v })
        return true
    })
    return out
}

function findBlockChangeId(editor: Editor): string | null {
    const entries = collectBlockChanges(editor)
    return entries.length > 0 ? entries[0].payload.suggestionId : null
}

function hasSuggestedDeleteMark(editor: Editor, suggestionId: string): boolean {
    let found = false
    editor.state.doc.descendants(node => {
        if (!node.isText) return true
        for (const m of node.marks) {
            if (m.type.name === 'suggestedDelete' && m.attrs.suggestionId === suggestionId) {
                found = true
            }
        }
        return true
    })
    return found
}

describe('Phase 5 block-change end-to-end integration', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0))
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('Test 1: heading toggle round-trip — propose, accept, becomes heading', () => {
        const { editor, yDoc, modeStore } = setupEditor({
            content: {
                type: 'doc',
                content: [
                    {
                        type: 'paragraph',
                        content: [{ type: 'text', text: 'hello world' }],
                    },
                ],
            },
        })

        // Propose the heading toggle.
        editor.commands.setTextSelection({ from: 1, to: 6 })
        editor.commands.setHeading({ level: 2 })

        // The visible doc is still a paragraph — the user's structural
        // change was reverted by the command layer.
        const entries = collectBlockChanges(editor)
        expect(entries).toHaveLength(1)
        expect(entries[0].nodeType).toBe('paragraph')
        expect(entries[0].payload.before.type).toBe('paragraph')
        expect(entries[0].payload.after.type).toBe('heading')
        expect(entries[0].payload.after.attrs.level).toBe(2)
        expect(entries[0].payload.authorId).toBe('uo_alice')
        const id = entries[0].payload.suggestionId

        // Accept. Switch to editing mode so the resolver's PM writes
        // don't get re-intercepted as fresh proposals.
        modeStore.getState().setMode(EDITOR_MODE_EDITING)
        acceptSuggestion(editor, id, { resolverUserId: 'uo_carol', yDoc })

        // The block is now a heading at level 2 with the original
        // content; the wrapper attribute is gone.
        const root = editor.state.doc.firstChild
        expect(root?.type.name).toBe('heading')
        expect(root?.attrs.level).toBe(2)
        expect(root?.textContent).toBe('hello world')
        expect(root?.attrs.suggestedBlockChange).toBeFalsy()
        editor.destroy()
    })

    it('Test 2: alignment change — propose then reject restores default', () => {
        // The TextAlign extension exposes setTextAlign() as a Tiptap
        // command. We propose center alignment, verify it's tracked as
        // a suggestedBlockChange, then reject and confirm the paragraph
        // is back to the default alignment (null) with no wrapper.
        const { editor, yDoc, modeStore } = setupEditor({
            content: {
                type: 'doc',
                content: [
                    {
                        type: 'paragraph',
                        content: [{ type: 'text', text: 'centered' }],
                    },
                ],
            },
        })

        editor.commands.setTextSelection({ from: 1, to: 8 })
        editor.commands.setTextAlign('center')

        // Suggesting mode: the textAlign attr is NOT applied yet;
        // the change is recorded as a suggestedBlockChange.
        const entries = collectBlockChanges(editor)
        expect(entries).toHaveLength(1)
        const { nodeType, payload } = entries[0]
        expect(nodeType).toBe('paragraph')
        expect(payload.before.type).toBe('paragraph')
        expect(payload.after.type).toBe('paragraph')
        // Visible paragraph has its original (null) textAlign.
        expect(editor.state.doc.firstChild?.attrs.textAlign).toBeFalsy()
        // The proposal records the target alignment.
        expect(payload.after.attrs.textAlign).toBe('center')
        const id = payload.suggestionId

        modeStore.getState().setMode(EDITOR_MODE_EDITING)
        rejectSuggestion(editor, id, { resolverUserId: 'uo_carol', yDoc })

        // Reject: paragraph back to default alignment, wrapper gone.
        const after = editor.state.doc.firstChild
        expect(after?.type.name).toBe('paragraph')
        expect(after?.attrs.textAlign).toBeFalsy()
        expect(after?.attrs.suggestedBlockChange).toBeFalsy()
        editor.destroy()
    })

    it('Test 3: block delete — propose, then accept removes block', () => {
        // Two paragraphs: "first" then "second". Propose deletion of
        // the "second" paragraph by deleting its full range; the
        // command layer must restore the block and stamp the
        // suggestedBlockChange + suggestedDelete marks. Accept then
        // honors the proposal.
        const { editor, yDoc, modeStore } = setupEditor({
            content: {
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
            },
        })

        // Doc positions:
        //   pos 0 : <p>first</p>  (size 7)
        //   pos 7 : <p>second</p> (size 8)
        // Delete the second paragraph entirely [7, 15).
        editor.commands.command(({ tr, dispatch }) => {
            tr.delete(7, 15)
            dispatch?.(tr)
            return true
        })

        // Still 2 paragraphs visible (the command layer restored it).
        expect(editor.state.doc.childCount).toBe(2)
        const blockChanges = collectBlockChanges(editor)
        // The deleted block carries a suggestedBlockChange with
        // after.deleted === true.
        const deletedEntry = blockChanges.find(e => e.payload.after.deleted === true)
        expect(deletedEntry).toBeDefined()
        const id = deletedEntry?.payload.suggestionId as string
        // Inline content of the restored block has suggestedDelete
        // marks with the same suggestionId.
        expect(hasSuggestedDeleteMark(editor, id)).toBe(true)

        modeStore.getState().setMode(EDITOR_MODE_EDITING)
        acceptSuggestion(editor, id, { resolverUserId: 'uo_carol', yDoc })

        // After accept: only "first" remains.
        expect(editor.state.doc.childCount).toBe(1)
        expect(editor.state.doc.firstChild?.textContent).toBe('first')
        editor.destroy()
    })

    it('Test 4: multiple changes within session window share one suggestionId; bulk reject reverts both', () => {
        const { editor, yDoc, modeStore } = setupEditor({
            content: {
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
            },
        })

        // First block change: set heading on paragraph A.
        editor.commands.setTextSelection({ from: 1, to: 6 })
        editor.commands.setHeading({ level: 2 })

        // Stay well inside the 30s session window.
        vi.advanceTimersByTime(200)

        // Second block change: alignment on paragraph B.
        // Paragraph B starts at pos 7 (after first paragraph's size 7).
        editor.commands.setTextSelection({ from: 8, to: 14 })
        editor.commands.setTextAlign('center')

        const entries = collectBlockChanges(editor)
        expect(entries).toHaveLength(2)
        // Same suggestionId across the two block-changes — session-
        // grouping collapses rapid-fire edits into one logical
        // suggestion.
        const ids = new Set(entries.map(e => e.payload.suggestionId))
        expect(ids.size).toBe(1)
        const id = entries[0].payload.suggestionId

        // Bulk reject by suggestionId — one reject call cleans up
        // both blocks.
        modeStore.getState().setMode(EDITOR_MODE_EDITING)
        rejectSuggestion(editor, id, { resolverUserId: 'uo_carol', yDoc })

        // Both blocks reverted to their original shape.
        const blocks: Array<{ type: string; attrs: Record<string, unknown> }> = []
        editor.state.doc.descendants(node => {
            if (node.type.name === 'paragraph' || node.type.name === 'heading') {
                blocks.push({ type: node.type.name, attrs: { ...node.attrs } })
            }
            return true
        })
        expect(blocks).toHaveLength(2)
        // Block A is still a paragraph (heading proposal rejected).
        expect(blocks[0].type).toBe('paragraph')
        // Block B has its default alignment (center proposal rejected).
        expect(blocks[1].type).toBe('paragraph')
        expect(blocks[1].attrs.textAlign).toBeFalsy()
        // Neither block carries the suggestedBlockChange wrapper.
        expect(blocks[0].attrs.suggestedBlockChange).toBeFalsy()
        expect(blocks[1].attrs.suggestedBlockChange).toBeFalsy()
        editor.destroy()
    })

    it('Test 5: editing mode applies block changes directly with no suggestedBlockChange attribute', () => {
        const { editor } = setupEditor({
            content: {
                type: 'doc',
                content: [
                    {
                        type: 'paragraph',
                        content: [{ type: 'text', text: 'plain' }],
                    },
                ],
            },
            mode: EDITOR_MODE_EDITING,
        })

        editor.commands.setTextSelection({ from: 1, to: 6 })
        editor.commands.setHeading({ level: 2 })

        // The block is now a heading. No suggestion was created.
        const root = editor.state.doc.firstChild
        expect(root?.type.name).toBe('heading')
        expect(root?.attrs.level).toBe(2)
        expect(root?.attrs.suggestedBlockChange).toBeFalsy()
        // And no block-change entries anywhere in the doc.
        expect(collectBlockChanges(editor)).toHaveLength(0)
        // Sanity: ensure ID lookup returns null in editing mode.
        expect(findBlockChangeId(editor)).toBeNull()
        editor.destroy()
    })
})
