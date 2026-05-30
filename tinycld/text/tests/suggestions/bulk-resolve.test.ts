// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { buildSuggestionEditorExtensions } from '~/tinycld/text/lib/suggestions/build-extensions'
import { bulkAccept, bulkReject } from '~/tinycld/text/lib/suggestions/bulk-resolve'
import { SuggestionsMap } from '~/tinycld/text/lib/suggestions/suggestions-map'
import {
    SUGGESTION_STATUS_ACCEPTED,
    SUGGESTION_STATUS_REJECTED,
} from '~/tinycld/text/webview-editor/source/suggestions/suggestion-types'

function makeDocWithSuggestions(ids: string[]) {
    const yDoc = new Y.Doc()
    const content = {
        type: 'doc',
        content: ids.map(id => ({
            type: 'paragraph',
            content: [
                {
                    type: 'text',
                    text: `suggestion-${id}`,
                    marks: [
                        {
                            type: 'suggestedInsert',
                            attrs: { suggestionId: id, authorId: 'uo_alice', ts: 1000 },
                        },
                    ],
                },
            ],
        })),
    }
    const editor = new Editor({
        extensions: [StarterKit, ...buildSuggestionEditorExtensions()],
        content,
    })
    const map = new SuggestionsMap(yDoc)
    for (const id of ids) {
        map.create({ id, authorId: 'uo_alice', createdAt: 1000 })
    }
    return { editor, yDoc, map }
}

describe('bulkAccept', () => {
    it('flips status to accepted for every suggestion in the list', () => {
        const { editor, yDoc, map } = makeDocWithSuggestions(['s1', 's2', 's3'])
        bulkAccept(editor, ['s1', 's2', 's3'], { resolverUserOrgId: 'uo_carol', yDoc })
        for (const id of ['s1', 's2', 's3']) {
            expect(map.get(id)?.status).toBe(SUGGESTION_STATUS_ACCEPTED)
        }
        // All insert marks gone (text remains)
        let hasInsertMark = false
        editor.state.doc.descendants(node => {
            if (node.marks.some(m => m.type.name === 'suggestedInsert')) {
                hasInsertMark = true
            }
        })
        expect(hasInsertMark).toBe(false)
        editor.destroy()
    })

    it('commits in a small number of Yjs transactions (not one per suggestion)', () => {
        const { editor, yDoc } = makeDocWithSuggestions(['s1', 's2', 's3'])
        const txCount = { value: 0 }
        yDoc.on('afterTransaction', () => {
            txCount.value++
        })
        bulkAccept(editor, ['s1', 's2', 's3'], { resolverUserOrgId: 'uo_carol', yDoc })
        // The bulk operation should produce FAR fewer Yjs transactions
        // than the per-suggestion count. y-prosemirror may dispatch the
        // PM step separately from the map write, so we allow a small
        // number, but never 3+ (one per suggestion).
        expect(txCount.value).toBeLessThanOrEqual(2)
        editor.destroy()
    })

    it('skips ids that are not in the map (defensive)', () => {
        const { editor, yDoc, map } = makeDocWithSuggestions(['s1'])
        // s-missing is not in the map nor the doc
        bulkAccept(editor, ['s1', 's-missing'], {
            resolverUserOrgId: 'uo_carol',
            yDoc,
        })
        expect(map.get('s1')?.status).toBe(SUGGESTION_STATUS_ACCEPTED)
        expect(map.get('s-missing')).toBeUndefined()
        editor.destroy()
    })

    it('empty list is a no-op', () => {
        const { editor, yDoc, map } = makeDocWithSuggestions(['s1'])
        bulkAccept(editor, [], { resolverUserOrgId: 'uo_carol', yDoc })
        expect(map.get('s1')?.status).not.toBe(SUGGESTION_STATUS_ACCEPTED)
        editor.destroy()
    })
})

describe('bulkReject', () => {
    it('flips status to rejected and removes all marked text', () => {
        const { editor, yDoc, map } = makeDocWithSuggestions(['s1', 's2', 's3'])
        bulkReject(editor, ['s1', 's2', 's3'], { resolverUserOrgId: 'uo_carol', yDoc })
        for (const id of ['s1', 's2', 's3']) {
            expect(map.get(id)?.status).toBe(SUGGESTION_STATUS_REJECTED)
        }
        // All inserted text removed
        expect(editor.state.doc.textContent).not.toContain('suggestion-s1')
        expect(editor.state.doc.textContent).not.toContain('suggestion-s2')
        editor.destroy()
    })
})
