import { Mark, mergeAttributes } from '@tiptap/core'

/**
 * SuggestedDelete TipTap mark.
 *
 * Inline mark applied to text that has been proposed for removal in
 * a suggesting-mode edit. Carries the originating suggestionId,
 * authorId (the user who proposed the deletion), and ts (proposal
 * timestamp in Unix ms).
 *
 * Crucially, a SuggestedDelete may co-exist on the same range as a
 * SuggestedInsert from a different user — this is spec Case 2b(i):
 * one user proposes deletion of text another user proposed inserting,
 * and both suggestions must remain independently accept/rejectable.
 *
 * Both parseHTML and renderHTML are required so that the mark
 * survives the y-prosemirror serialization boundary (the WebView
 * editor's Yjs round-trip) AND round-trips through docx export/import
 * (phase 5 docx work). The parseHTML tag selector requires all three
 * data attributes — a span without any one of them is not reparsed
 * as a suggestedDelete, which is the codebase's idiom (see CommentMark
 * and BlockIndent) for surviving malformed input without crashing.
 *
 * Phase 2 adds the suggest-mode command layer that creates these
 * marks and the strikethrough rendering of deleted text; phase 5
 * adds the docx round-trip via WordZero's w:del.
 */

export interface SuggestedDeleteAttrs {
    suggestionId: string
    authorId: string
    ts: number
}

export const SuggestedDelete = Mark.create({
    name: 'suggestedDelete',
    // inclusive: false because the command layer (command-layer.ts)
    // explicitly calls addMark on exact ranges; we never want a
    // previous user's mark to carry forward onto another user's
    // adjacent keystrokes. With inclusive: true + excludes: '', the
    // two flags interacted to create an author-credit leak — Bob's
    // typing at the boundary of Alice's run would inherit Alice's
    // mark, stacking instead of replacing per excludes: ''.
    inclusive: false,
    // excludes: '' lets multiple suggestedDelete marks coexist on the
    // same range, recording each contributing author's proposal
    // independently. Spec Case 2c: two users proposing the same edit
    // both register their suggestionId. Without this, PM's default
    // (excludes: name) would replace the earlier mark.
    excludes: '',

    addAttributes() {
        return {
            suggestionId: {
                default: null,
                parseHTML: el => el.getAttribute('data-suggestion-id'),
                renderHTML: attrs => {
                    if (!attrs.suggestionId) {
                        return {}
                    }
                    return { 'data-suggestion-id': attrs.suggestionId }
                },
            },
            authorId: {
                default: null,
                parseHTML: el => el.getAttribute('data-author-id'),
                renderHTML: attrs => {
                    if (!attrs.authorId) {
                        return {}
                    }
                    return { 'data-author-id': attrs.authorId }
                },
            },
            ts: {
                default: null,
                parseHTML: el => {
                    const v = el.getAttribute('data-ts')
                    const n = v ? Number(v) : Number.NaN
                    return Number.isFinite(n) ? n : null
                },
                renderHTML: attrs => {
                    if (typeof attrs.ts !== 'number' || !Number.isFinite(attrs.ts)) {
                        return {}
                    }
                    return { 'data-ts': String(attrs.ts) }
                },
            },
        }
    },

    parseHTML() {
        return [
            {
                tag: 'span[data-suggested-delete][data-suggestion-id][data-author-id][data-ts]',
            },
        ]
    },

    renderHTML({ HTMLAttributes }) {
        return ['span', mergeAttributes({ 'data-suggested-delete': '' }, HTMLAttributes), 0]
    },
})
