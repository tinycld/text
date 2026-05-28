// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { buildSuggestionEditorExtensions } from '~/tinycld/text/lib/suggestions/build-extensions'
import { computeDocumentSuggestions } from '~/tinycld/text/hooks/use-document-suggestions'
import { bulkAccept, bulkReject } from '~/tinycld/text/lib/suggestions/bulk-resolve'
import { SuggestionsMap } from '~/tinycld/text/lib/suggestions/suggestions-map'
import {
    EDITOR_MODE_SUGGESTING,
    createEditorModeStore,
} from '~/tinycld/text/stores/editor-mode-store'
import {
    SUGGESTION_STATUS_ACCEPTED,
    SUGGESTION_STATUS_REJECTED,
} from '~/tinycld/text/webview-editor/source/suggestions/suggestion-types'

describe('Phase 2b smoke', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0))
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('three suggestions in doc order → bulkAccept resolves all three', () => {
        const modeStore = createEditorModeStore()
        modeStore.getState().setIdentity({ userOrgId: 'uo_alice' })
        modeStore.getState().setMode(EDITOR_MODE_SUGGESTING)
        const yDoc = new Y.Doc()

        const editor = new Editor({
            extensions: [
                StarterKit,
                ...buildSuggestionEditorExtensions({ modeStore, yDoc }),
            ],
            content: {
                type: 'doc',
                content: [
                    { type: 'paragraph', content: [{ type: 'text', text: 'A' }] },
                    { type: 'paragraph', content: [{ type: 'text', text: 'B' }] },
                    { type: 'paragraph', content: [{ type: 'text', text: 'C' }] },
                ],
            },
        })

        // Make three separate suggestions (advance time past the 30s
        // window between each so they get different suggestionIds).
        editor.commands.focus(2)
        editor.commands.insertContent({ type: 'text', text: '-a' })
        vi.advanceTimersByTime(31_000)
        editor.commands.focus(7)
        editor.commands.insertContent({ type: 'text', text: '-b' })
        vi.advanceTimersByTime(31_000)
        editor.commands.focus(12)
        editor.commands.insertContent({ type: 'text', text: '-c' })

        const map = new SuggestionsMap(yDoc)
        const result = computeDocumentSuggestions(editor.state.doc, map)
        expect(result.anchored.length).toBeGreaterThanOrEqual(3)

        const ids = result.anchored.map((r) => r.id)
        bulkAccept(editor, ids, { resolverUserOrgId: 'uo_carol', yDoc })

        for (const id of ids) {
            expect(map.get(id)?.status).toBe(SUGGESTION_STATUS_ACCEPTED)
        }
        // Marks all gone
        let hasMarks = false
        editor.state.doc.descendants((node) => {
            if (
                node.marks.some(
                    (m) =>
                        m.type.name === 'suggestedInsert' ||
                        m.type.name === 'suggestedDelete'
                )
            ) {
                hasMarks = true
            }
        })
        expect(hasMarks).toBe(false)
        editor.destroy()
    })

    it('two users propose deletion of the same range → both rows in the list', () => {
        const yDoc = new Y.Doc()
        const editor = new Editor({
            extensions: [
                StarterKit,
                ...buildSuggestionEditorExtensions(),
            ],
            content: {
                type: 'doc',
                content: [
                    {
                        type: 'paragraph',
                        content: [
                            {
                                type: 'text',
                                text: 'doomed',
                                marks: [
                                    {
                                        type: 'suggestedDelete',
                                        attrs: {
                                            suggestionId: 's-bob',
                                            authorId: 'uo_bob',
                                            ts: 1000,
                                        },
                                    },
                                    {
                                        type: 'suggestedDelete',
                                        attrs: {
                                            suggestionId: 's-carol',
                                            authorId: 'uo_carol',
                                            ts: 2000,
                                        },
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
        })
        const map = new SuggestionsMap(yDoc)
        map.create({ id: 's-bob', authorId: 'uo_bob', createdAt: 1000 })
        map.create({ id: 's-carol', authorId: 'uo_carol', createdAt: 2000 })

        const result = computeDocumentSuggestions(editor.state.doc, map)
        // Both delete suggestions are anchored — Case 2c.
        const deletes = result.anchored.filter((r) => r.kind === 'delete')
        expect(deletes).toHaveLength(2)
        expect(deletes.map((d) => d.authorId).sort()).toEqual(['uo_bob', 'uo_carol'])

        // Accepting just Bob's leaves Carol's mark still on the text.
        bulkAccept(editor, ['s-bob'], {
            resolverUserOrgId: 'uo_dave',
            yDoc,
        })
        expect(map.get('s-bob')?.status).toBe(SUGGESTION_STATUS_ACCEPTED)
        // Bob's delete-accept removed the text. Carol's mark was on
        // the deleted range and is gone too — but her Y.Map entry is
        // still open (orphaned).
        const result2 = computeDocumentSuggestions(editor.state.doc, map)
        expect(result2.orphaned.map((o) => o.id)).toContain('s-carol')

        editor.destroy()
    })

    it('bulkReject removes inserted text and flips status', () => {
        const yDoc = new Y.Doc()
        const editor = new Editor({
            extensions: [
                StarterKit,
                ...buildSuggestionEditorExtensions(),
            ],
            content: {
                type: 'doc',
                content: [
                    {
                        type: 'paragraph',
                        content: [
                            {
                                type: 'text',
                                text: 'UNWANTED',
                                marks: [
                                    {
                                        type: 'suggestedInsert',
                                        attrs: {
                                            suggestionId: 's1',
                                            authorId: 'uo_alice',
                                            ts: 100,
                                        },
                                    },
                                ],
                            },
                        ],
                    },
                    {
                        type: 'paragraph',
                        content: [
                            {
                                type: 'text',
                                text: 'KEEP',
                            },
                        ],
                    },
                ],
            },
        })
        const map = new SuggestionsMap(yDoc)
        map.create({ id: 's1', authorId: 'uo_alice', createdAt: 100 })
        bulkReject(editor, ['s1'], { resolverUserOrgId: 'uo_carol', yDoc })
        expect(editor.state.doc.textContent).not.toContain('UNWANTED')
        expect(editor.state.doc.textContent).toContain('KEEP')
        expect(map.get('s1')?.status).toBe(SUGGESTION_STATUS_REJECTED)
        editor.destroy()
    })
})
