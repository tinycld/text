// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { buildSuggestionEditorExtensions } from '~/tinycld/text/lib/suggestions/build-extensions'
import { SuggestionsMap } from '~/tinycld/text/lib/suggestions/suggestions-map'
import {
    createEditorModeStore,
    EDITOR_MODE_EDITING,
    EDITOR_MODE_SUGGESTING,
} from '~/tinycld/text/stores/editor-mode-store'

// Phase 5 integration: when the user is in suggesting mode and runs
// a mark-toggle command (toggleBold / toggleItalic / link / …), the
// command layer must intercept and replace the raw mark with a
// suggestedFormatChange carrying before/after snapshots. The visible
// bold/italic mark itself must NOT land — the decoration plugin
// renders the pending change as an overlay.

describe('Phase 5 format-change interception', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0))
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('toggleBold in editing mode applies the bold mark normally (no interception)', () => {
        const modeStore = createEditorModeStore()
        modeStore.getState().setIdentity({ userOrgId: 'uo_alice' })
        modeStore.getState().setMode(EDITOR_MODE_EDITING)
        const yDoc = new Y.Doc()

        const editor = new Editor({
            extensions: [StarterKit, ...buildSuggestionEditorExtensions({ modeStore, yDoc })],
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

        // Select "hello" and toggle bold.
        editor.commands.setTextSelection({ from: 1, to: 6 })
        editor.commands.toggleBold()

        let hasBold = false
        let hasFormatChange = false
        editor.state.doc.descendants(node => {
            for (const m of node.marks) {
                if (m.type.name === 'bold') hasBold = true
                if (m.type.name === 'suggestedFormatChange') hasFormatChange = true
            }
        })
        expect(hasBold).toBe(true)
        expect(hasFormatChange).toBe(false)
        editor.destroy()
    })

    it('toggleBold in suggesting mode stamps suggestedFormatChange with before/after', () => {
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
                        content: [{ type: 'text', text: 'hello world' }],
                    },
                ],
            },
        })

        // Select "hello" (positions 1..6 inclusive of the paragraph
        // open, exclusive of position 6) and toggle bold.
        editor.commands.setTextSelection({ from: 1, to: 6 })
        editor.commands.toggleBold()

        // Walk the doc and find the suggestedFormatChange mark.
        let fcMark: { suggestionId: string; before: unknown; after: unknown } | null = null
        let fcRange: { from: number; to: number } | null = null
        let hasBold = false
        editor.state.doc.descendants((node, pos) => {
            if (!node.isText) return true
            for (const m of node.marks) {
                if (m.type.name === 'bold') hasBold = true
                if (m.type.name === 'suggestedFormatChange') {
                    fcMark = {
                        suggestionId: m.attrs.suggestionId as string,
                        before: m.attrs.before,
                        after: m.attrs.after,
                    }
                    fcRange = { from: pos, to: pos + node.nodeSize }
                }
            }
            return true
        })

        // The visible bold mark must NOT have landed — the suggestion
        // is "pending", not applied.
        expect(hasBold).toBe(false)
        expect(fcMark).not.toBeNull()
        expect(fcRange).not.toBeNull()
        // Use the result and cast through unknown to keep biome happy
        // about the asymmetric null narrowing.
        const fc = fcMark as unknown as {
            suggestionId: string
            before: unknown
            after: unknown
        }
        expect(typeof fc.suggestionId).toBe('string')
        expect(fc.suggestionId.length).toBeGreaterThan(0)
        expect(fc.before).toEqual([])
        expect(fc.after).toEqual([{ type: 'bold' }])

        // And the range must cover the selected text.
        const r = fcRange as unknown as { from: number; to: number }
        expect(r.from).toBe(1)
        expect(r.to).toBe(6)

        // The suggestions Y.Map entry must exist for the resolver.
        const map = new SuggestionsMap(yDoc)
        const entry = map.get(fc.suggestionId)
        expect(entry?.authorId).toBe('uo_alice')

        editor.destroy()
    })

    it('toggleBold removing a previously-bolded run stamps before=[bold], after=[]', () => {
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
                        content: [
                            {
                                type: 'text',
                                text: 'hello',
                                marks: [{ type: 'bold' }],
                            },
                            { type: 'text', text: ' world' },
                        ],
                    },
                ],
            },
        })

        // Select the already-bold "hello" run and toggle bold to remove it.
        editor.commands.setTextSelection({ from: 1, to: 6 })
        editor.commands.toggleBold()

        let fcMark: { before: unknown; after: unknown } | null = null
        let stillBoldInRange = false
        editor.state.doc.descendants((node, pos) => {
            if (!node.isText) return true
            // Inspect marks on text overlapping the toggled range.
            const inRange = pos < 6 && pos + node.nodeSize > 1
            if (!inRange) return true
            for (const m of node.marks) {
                if (m.type.name === 'bold') stillBoldInRange = true
                if (m.type.name === 'suggestedFormatChange') {
                    fcMark = {
                        before: m.attrs.before,
                        after: m.attrs.after,
                    }
                }
            }
            return true
        })

        // The original bold mark should be re-added (we undid the user's
        // removal), so the underlying run is still bold.
        expect(stillBoldInRange).toBe(true)
        expect(fcMark).not.toBeNull()
        const fc = fcMark as unknown as { before: unknown; after: unknown }
        expect(fc.before).toEqual([{ type: 'bold' }])
        expect(fc.after).toEqual([])

        editor.destroy()
    })

    it('two rapid toggleBold calls in suggesting mode share one suggestionId', () => {
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
                        content: [{ type: 'text', text: 'hello world abc' }],
                    },
                ],
            },
        })

        editor.commands.setTextSelection({ from: 1, to: 6 })
        editor.commands.toggleBold()
        vi.advanceTimersByTime(200)
        editor.commands.setTextSelection({ from: 7, to: 12 })
        editor.commands.toggleItalic()

        const ids = new Set<string>()
        editor.state.doc.descendants(node => {
            for (const m of node.marks) {
                if (m.type.name === 'suggestedFormatChange') {
                    ids.add(m.attrs.suggestionId as string)
                }
            }
        })
        expect(ids.size).toBe(1)
        editor.destroy()
    })

    it('suggestedFormatChange is removable on accept (mark-strip works)', () => {
        // Phase 5 Task 5 builds the full accept/reject path; here we
        // just verify the mechanical removal works — the range, the
        // mark type, and the schema all interact correctly.
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
                        content: [{ type: 'text', text: 'hello world' }],
                    },
                ],
            },
        })

        editor.commands.setTextSelection({ from: 1, to: 6 })
        editor.commands.toggleBold()

        // Collect the suggested-format-change range.
        let range: { from: number; to: number } | null = null
        editor.state.doc.descendants((node, pos) => {
            if (!node.isText) return true
            if (node.marks.some(m => m.type.name === 'suggestedFormatChange')) {
                range = { from: pos, to: pos + node.nodeSize }
            }
            return true
        })
        expect(range).not.toBeNull()
        const r = range as unknown as { from: number; to: number }

        // Switch to editing mode before stripping (mirrors what the
        // real resolver does in Task 5 — interception is suppressed
        // outside suggesting mode).
        modeStore.getState().setMode(EDITOR_MODE_EDITING)
        const formatChangeMarkType = editor.state.schema.marks.suggestedFormatChange
        const tr = editor.state.tr.removeMark(r.from, r.to, formatChangeMarkType)
        editor.view.dispatch(tr)

        let stillHasFormatChange = false
        editor.state.doc.descendants(node => {
            if (node.marks.some(m => m.type.name === 'suggestedFormatChange')) {
                stillHasFormatChange = true
            }
        })
        expect(stillHasFormatChange).toBe(false)

        editor.destroy()
    })
})
