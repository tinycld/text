import { useBaseCommentMutations } from '@tinycld/core/lib/comments'
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
// snapshot. Mentions are deferred to PR3c — for now the mentions field
// in core's mutations factory is unused.
export function useCommentMutations() {
    const [textCommentsCollection] = useStore('text_comments')

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
        }),
    })
}
