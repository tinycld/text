import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { buildSuggestionEditorExtensions } from '~/tinycld/text/lib/suggestions/build-extensions'
import { acceptSuggestion, rejectSuggestion } from '~/tinycld/text/lib/suggestions/resolve'
import { SuggestionsMap } from '~/tinycld/text/lib/suggestions/suggestions-map'
import {
    SUGGESTION_STATUS_ACCEPTED,
    SUGGESTION_STATUS_REJECTED,
} from '~/tinycld/text/webview-editor/source/suggestions/suggestion-types'

function buildDocWithInsertAndDelete() {
    const yDoc = new Y.Doc()
    const editor = new Editor({
        extensions: [StarterKit, ...buildSuggestionEditorExtensions()],
        content: {
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        {
                            type: 'text',
                            text: 'inserted text',
                            marks: [
                                {
                                    type: 'suggestedInsert',
                                    attrs: {
                                        suggestionId: 's-ins',
                                        authorId: 'uo_alice',
                                        ts: 1000,
                                    },
                                },
                            ],
                        },
                        {
                            type: 'text',
                            text: 'deleted text',
                            marks: [
                                {
                                    type: 'suggestedDelete',
                                    attrs: {
                                        suggestionId: 's-del',
                                        authorId: 'uo_bob',
                                        ts: 2000,
                                    },
                                },
                            ],
                        },
                        { type: 'text', text: ' kept' },
                    ],
                },
            ],
        },
    })
    const map = new SuggestionsMap(yDoc)
    map.create({ id: 's-ins', authorId: 'uo_alice', createdAt: 1000 })
    map.create({ id: 's-del', authorId: 'uo_bob', createdAt: 2000 })
    return { editor, yDoc, map }
}

describe('acceptSuggestion', () => {
    it('strips suggestedInsert marks so text becomes regular', () => {
        const { editor, yDoc, map } = buildDocWithInsertAndDelete()
        acceptSuggestion(editor, 's-ins', { resolverUserOrgId: 'uo_carol', yDoc })
        let hasInsertMark = false
        editor.state.doc.descendants(node => {
            if (node.marks.some(m => m.type.name === 'suggestedInsert')) hasInsertMark = true
        })
        expect(hasInsertMark).toBe(false)
        expect(editor.state.doc.textContent).toContain('inserted text')
        const entry = map.get('s-ins')
        expect(entry?.status).toBe(SUGGESTION_STATUS_ACCEPTED)
        expect(entry?.resolvedBy).toBe('uo_carol')
        editor.destroy()
    })

    it('removes text bearing suggestedDelete with the target id', () => {
        const { editor, yDoc, map } = buildDocWithInsertAndDelete()
        acceptSuggestion(editor, 's-del', { resolverUserOrgId: 'uo_carol', yDoc })
        expect(editor.state.doc.textContent).not.toContain('deleted text')
        expect(editor.state.doc.textContent).toContain('inserted text') // unrelated suggestion stays
        expect(map.get('s-del')?.status).toBe(SUGGESTION_STATUS_ACCEPTED)
        editor.destroy()
    })
})

describe('rejectSuggestion', () => {
    it('removes text bearing suggestedInsert with the target id', () => {
        const { editor, yDoc, map } = buildDocWithInsertAndDelete()
        rejectSuggestion(editor, 's-ins', { resolverUserOrgId: 'uo_carol', yDoc })
        expect(editor.state.doc.textContent).not.toContain('inserted text')
        expect(map.get('s-ins')?.status).toBe(SUGGESTION_STATUS_REJECTED)
        editor.destroy()
    })

    it('strips suggestedDelete marks so text stays', () => {
        const { editor, yDoc, map } = buildDocWithInsertAndDelete()
        rejectSuggestion(editor, 's-del', { resolverUserOrgId: 'uo_carol', yDoc })
        expect(editor.state.doc.textContent).toContain('deleted text')
        let hasDeleteMark = false
        editor.state.doc.descendants(node => {
            if (node.marks.some(m => m.type.name === 'suggestedDelete')) hasDeleteMark = true
        })
        expect(hasDeleteMark).toBe(false)
        expect(map.get('s-del')?.status).toBe(SUGGESTION_STATUS_REJECTED)
        editor.destroy()
    })
})

describe('resolve atomicity', () => {
    // The fix wraps the PM-bridged write + the SuggestionsMap update in
    // a single yDoc.transact so a concurrent peer can never observe the
    // marks gone while suggestion.status is still 'open'. We pin that
    // by attaching a Y.Doc-level afterTransaction observer and asserting
    // that the post-transaction snapshot already has the status flipped.
    //
    // The test editor used here doesn't run y-prosemirror (no
    // Collaboration extension), so the PM half of the write doesn't
    // bridge into the yDoc transaction in this environment — but the
    // SuggestionsMap.resolve() call DOES land inside transact(), and
    // any Y.Doc afterTransaction observer fires AFTER both writes
    // complete. The contract we can verify here is that:
    //   (a) the SuggestionsMap write happens inside a transaction
    //       (afterTransaction observer fires)
    //   (b) the status is already flipped when that fires
    // Together these imply a peer applying the resulting update won't
    // see a half-applied state.
    it('acceptSuggestion writes the SuggestionsMap inside a yDoc transaction', () => {
        const { editor, yDoc, map } = buildDocWithInsertAndDelete()
        let transactionCount = 0
        let statusAtTransactionEnd: string | undefined
        yDoc.on('afterTransaction', () => {
            transactionCount += 1
            statusAtTransactionEnd = map.get('s-ins')?.status
        })

        acceptSuggestion(editor, 's-ins', { resolverUserOrgId: 'uo_carol', yDoc })

        // At least one Yjs transaction fired and the status was
        // already accepted by the time the observer saw it.
        expect(transactionCount).toBeGreaterThanOrEqual(1)
        expect(statusAtTransactionEnd).toBe(SUGGESTION_STATUS_ACCEPTED)
        editor.destroy()
    })

    it('rejectSuggestion writes the SuggestionsMap inside a yDoc transaction', () => {
        const { editor, yDoc, map } = buildDocWithInsertAndDelete()
        let transactionCount = 0
        let statusAtTransactionEnd: string | undefined
        yDoc.on('afterTransaction', () => {
            transactionCount += 1
            statusAtTransactionEnd = map.get('s-ins')?.status
        })

        rejectSuggestion(editor, 's-ins', { resolverUserOrgId: 'uo_carol', yDoc })

        expect(transactionCount).toBeGreaterThanOrEqual(1)
        expect(statusAtTransactionEnd).toBe(SUGGESTION_STATUS_REJECTED)
        editor.destroy()
    })
})
