import { Mark, mergeAttributes } from '@tiptap/core'

// Tiptap mark anchoring a proposed insertion to a range of text. The
// `suggestionId` attribute matches the `id` field of the corresponding
// `Suggestion` record (see suggestion-types.ts). The mark itself
// replicates through Yjs XmlFragment, which is the source of truth for
// the inserted range — concurrent edits migrate the range automatically.
//
// Two-way attribute round-tripping (parseHTML + renderHTML) is required:
// y-prosemirror serializes marks to HTML when fragments cross the
// y-prosemirror boundary, and ProseMirror reads them back through the
// same parser. Omitting either side drops the attribute on the first
// remote update.
//
// suggestionId and authorId are required: every "suggested insert" must
// be attributable to a tracked suggestion + author. We enforce that in
// renderHTML rather than at mark-create time because ProseMirror's
// Mark.create permits `default: null` attribute values; the throw fires
// the first time the mark is serialized to DOM (e.g. via DOMSerializer
// or through the y-prosemirror boundary), catching programming bugs
// before bad data escapes the editor.

export interface SuggestedInsertAttrs {
    suggestionId: string
    authorId: string
    ts: number
}

export const SuggestedInsert = Mark.create({
    name: 'suggestedInsert',
    inclusive: true,

    addAttributes() {
        return {
            suggestionId: {
                default: null,
                parseHTML: el => el.getAttribute('data-suggestion-id'),
                renderHTML: attrs => {
                    if (!attrs.suggestionId) {
                        throw new Error('suggestedInsert mark requires suggestionId')
                    }
                    return { 'data-suggestion-id': attrs.suggestionId as string }
                },
            },
            authorId: {
                default: null,
                parseHTML: el => el.getAttribute('data-author-id'),
                renderHTML: attrs => {
                    if (!attrs.authorId) {
                        throw new Error('suggestedInsert mark requires authorId')
                    }
                    return { 'data-author-id': attrs.authorId as string }
                },
            },
            ts: {
                default: 0,
                parseHTML: el => {
                    const v = el.getAttribute('data-ts')
                    return v ? Number(v) : 0
                },
                renderHTML: attrs => ({ 'data-ts': String(attrs.ts ?? 0) }),
            },
        }
    },

    parseHTML() {
        return [{ tag: 'span[data-suggested-insert]' }]
    },

    renderHTML({ HTMLAttributes }) {
        return ['span', mergeAttributes({ 'data-suggested-insert': '' }, HTMLAttributes), 0]
    },
})
