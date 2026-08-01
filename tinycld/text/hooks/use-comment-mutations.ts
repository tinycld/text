import { useBaseCommentMutations } from '@tinycld/core/lib/comments'
import { useEditorMount } from '@tinycld/core/lib/editor/editor-mount'
import { useStore } from '@tinycld/core/lib/pocketbase'
import type { TextComments } from '../types'

export interface AddCommentArgs {
    driveItemId: string
    commentId: string
    quotedText: string
    body: string
}

export interface ReplyArgs {
    driveItemId: string
    commentId: string
    quotedText: string
    parentId: string
    body: string
}

// Text-side comment mutations. Closes over the text_comments collection
// and shapes the insert with the comment_id anchor + quoted_text
// snapshot. Wired with the shared comment_mentions collection so any
// `[[@user_id]]` token in the body yields a notify-triggering row
// alongside the comment insert.
export function useCommentMutations() {
    const [textCommentsCollection, commentMentionsCollection] = useStore(
        'text_comments',
        'comment_mentions'
    )
    const { identity } = useEditorMount()

    return useBaseCommentMutations<
        Omit<TextComments, 'created' | 'updated'>,
        AddCommentArgs,
        ReplyArgs
    >({
        insertRow: row => textCommentsCollection.insert(row),
        updateRow: (id, mutator) => textCommentsCollection.update(id, mutator),
        deleteRow: id => textCommentsCollection.delete(id),
        buildInsert: (base, args) => ({
            ...base,
            comment_id: args.commentId,
            quoted_text: args.quotedText,
            // Phase 5 added two text_comments discriminator fields. A
            // regular anchored comment leaves both empty: `suggestion_id`
            // distinguishes the comment from a suggestion-thread reply
            // (useSuggestionDiscussion filters on it being set), and
            // `archived_at` is stamped server-side only when the parent
            // suggestion's Y.Map row is deleted.
            suggestion_id: '',
            archived_at: '',
        }),
        mentions: {
            commentCollection: 'text_comments',
            insertMention: row => commentMentionsCollection.insert(row),
        },
        // commentor+ roles always have a userId; author_name resolves from
        // displayName so email is unused here.
        identity: {
            userId: identity.userId ?? '',
            displayName: identity.displayName,
            email: '',
        },
    })
}
