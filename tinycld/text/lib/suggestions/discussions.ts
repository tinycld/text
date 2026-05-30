import { and, eq, isNull } from '@tanstack/db'
import type { Transaction } from '@tanstack/react-db'
import { parseMentions } from '@tinycld/core/lib/comments'
import { useMutation } from '@tinycld/core/lib/mutations'
import { useStore } from '@tinycld/core/lib/pocketbase'
import { useOrgLiveQuery } from '@tinycld/core/lib/use-org-live-query'
import { newRecordId } from 'pbtsdb/core'
import { useCallback, useMemo } from 'react'

// One discussion-thread reply persisted as a `text_comments` row.
// The PB row shape is shared with regular anchored comments — only
// the discriminators differ:
//   - `suggestion_id` set, `comment_id` set to a throwaway record id
//     (the column is required + indexed, so we can't leave it blank;
//     using a fresh id keeps the row out of the comments drawer's
//     groupBy(comment_id) buckets).
//   - `comment_mark` (in the plan's language, the Tiptap mark attr
//     that links a comment row to a span of text) is intentionally
//     absent — suggestion replies anchor on the suggestion's Y.Map
//     entry, not on a mark in the document.
//
// `mentions` is the flattened user_org id list extracted from the
// reply body's `[[@userOrgId]]` tokens (the same wire format the
// composer writes when an @-mention is picked). Parsed client-side
// via `parseMentions(body)` rather than a parallel `comment_mentions`
// subscription — that collection's listRule is null (system-only,
// only the notify hook reads it) and a client query would 403.
export interface SuggestionReply {
    id: string
    suggestionId: string
    authorId: string
    body: string
    createdAt: number
    mentions: string[]
}

export interface SuggestionDiscussion {
    replies: SuggestionReply[]
    addReply: (body: string, mentions: string[]) => Promise<void>
    isLoading: boolean
}

// Returned when there's nothing to subscribe to (no suggestion focused).
// Stable references keep memoized consumers from re-rendering needlessly.
const EMPTY_REPLIES: SuggestionReply[] = []
const NO_OP_ADD_REPLY = async () => {}

// useSuggestionDiscussion is the read+write adapter the suggestion
// thread UI sits on top of. It surfaces all `text_comments` rows
// tagged with a given `suggestion_id` (filtering archived rows) and
// provides a write path that mirrors the existing comment-composer
// mutation: one `text_comments` insert plus N `comment_mentions`
// inserts, atomically yielded through the shared generator pattern.
//
// `authorUserOrgId`, `driveItemId`, and `authorDisplayName` are passed
// in by the caller rather than read from `useEditorMount()` internally.
// That keeps the hook side-effect-free against the editor-mount context
// — so it works equally well from the drawer (which has the context) and
// from the screen-level bottom sheet on native (which mounts outside of
// it). The screen wires `useEditorMount()` once and passes the resolved
// values down.
//
// `authorDisplayName` is snapshotted into `author_name` on the row.
// PB's text_comments collection requires `author_name` to be a non-empty
// string (see pb-migrations/1720000000_create_text_comments.js — the
// field is required with max 200). Writing an empty string fails the
// insert silently; the mutation factory in `core/lib/comments` uses
// the same name→email→'Anonymous' fallback. We mirror that here so
// suggestion replies pass the same validation gate.
//
// When `suggestionId === null` the hook short-circuits to empty
// data + a no-op addReply, mirroring how `useAuthorName` returns
// null for a null author id — lets consumers render unconditionally
// without an extra `if (focused)` guard at every call site.
export function useSuggestionDiscussion(
    suggestionId: string | null,
    driveItemId: string,
    authorUserOrgId: string,
    authorDisplayName?: string
): SuggestionDiscussion {
    const [textCommentsCollection, commentMentionsCollection] = useStore(
        'text_comments',
        'comment_mentions'
    )

    // Subscribe to comment rows for this suggestion. We filter
    // `archived_at IS NULL` in the query so the soft-delete sweep
    // (Task 6's Y.Map observer) drops rows from the live thread
    // without us having to filter in JS. Ordering is server-stable
    // ascending `created` — replies render chronologically.
    //
    // We intentionally do NOT subscribe to comment_mentions on the
    // client. That collection's listRule/viewRule are null (only the
    // server-side notify hook reads it; clients only ever insert),
    // so any client query against it 403s. Mentions for display are
    // extracted from the reply body's `[[@userOrgId]]` tokens via
    // parseMentions — the composer writes those tokens directly, so
    // the body text IS the canonical mention list per row.
    const { data: commentRows = [], isLoading: commentsLoading } = useOrgLiveQuery(
        query =>
            suggestionId
                ? query
                      .from({ comment: textCommentsCollection })
                      .where(({ comment }) =>
                          and(eq(comment.suggestion_id, suggestionId), isNull(comment.archived_at))
                      )
                      .orderBy(({ comment }) => comment.created, 'asc')
                : null,
        [suggestionId]
    )

    const replies = useMemo<SuggestionReply[]>(() => {
        if (!suggestionId) return EMPTY_REPLIES
        const typedRows = commentRows as Array<{
            id: string
            suggestion_id?: string
            author: string
            body: string
            created: string
        }>
        return typedRows.map(row => ({
            id: row.id,
            suggestionId: row.suggestion_id ?? '',
            authorId: row.author,
            body: row.body,
            createdAt: new Date(row.created).getTime(),
            mentions: parseMentions(row.body).map(m => m.userOrgId),
        }))
    }, [suggestionId, commentRows])

    const addReplyMutation = useMutation({
        mutationFn: function* (args: { body: string; mentions: string[] }) {
            if (!suggestionId) return
            const newCommentId = newRecordId()
            // `comment_id` is a required text field on text_comments.
            // For an anchored comment it stores the Tiptap mark id;
            // for a suggestion reply we have no mark, so we synthesize
            // a fresh id. The fresh id is unique by construction (ULID),
            // so it can't collide with a real anchored-comment mark and
            // groupCommentsByKey in the comments drawer won't bucket
            // it together with anything else. `quoted_text` is
            // similarly absent — we store an empty string.
            // Snapshot the author's display name so the row passes
            // PB's required-non-empty author_name validation. Empty-
            // string fallbacks ('Anonymous') match the regular comment
            // mutation pipeline in core/lib/comments/mutations.ts.
            const snapshotAuthorName = authorDisplayName || 'Anonymous'
            yield textCommentsCollection.insert({
                id: newCommentId,
                drive_item: driveItemId,
                comment_id: newRecordId(),
                quoted_text: '',
                parent_comment: '',
                body: args.body,
                resolved_at: '',
                author: authorUserOrgId,
                author_name: snapshotAuthorName,
                suggestion_id: suggestionId,
            } as Parameters<typeof textCommentsCollection.insert>[0])

            // One `comment_mentions` row per mentioned user. The PB
            // notify hook fires off these inserts and dispatches a
            // notifications row — same pipeline as anchored-comment
            // mentions, no parallel notification path.
            const mentionTxs: Transaction<Record<string, unknown>>[] = []
            const seen = new Set<string>()
            for (const userOrgId of args.mentions) {
                if (seen.has(userOrgId)) continue
                if (userOrgId === authorUserOrgId) continue
                seen.add(userOrgId)
                mentionTxs.push(
                    commentMentionsCollection.insert({
                        id: newRecordId(),
                        comment_collection: 'text_comments',
                        comment_record: newCommentId,
                        drive_item: driveItemId,
                        mentioned_user_org: userOrgId,
                    } as Parameters<typeof commentMentionsCollection.insert>[0])
                )
            }
            if (mentionTxs.length > 0) yield mentionTxs
        },
    })

    const addReply = useCallback(
        async (body: string, mentions: string[]) => {
            if (!suggestionId) return
            await addReplyMutation.mutateAsync({ body, mentions })
        },
        [suggestionId, addReplyMutation]
    )

    if (!suggestionId) {
        return {
            replies: EMPTY_REPLIES,
            addReply: NO_OP_ADD_REPLY,
            isLoading: false,
        }
    }

    return {
        replies,
        addReply,
        isLoading: commentsLoading,
    }
}
