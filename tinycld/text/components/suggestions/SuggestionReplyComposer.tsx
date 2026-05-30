import { parseMentions } from '@tinycld/core/lib/comments'
import { useEditorMount } from '@tinycld/core/lib/editor/editor-mount'
import { CommentComposer } from '@tinycld/core/ui/comments'
import { useCallback, useState } from 'react'
import { View } from 'react-native'
import { useMentionSuggestions } from '../../hooks/use-mention-suggestions'

export interface SuggestionReplyComposerProps {
    onSubmit: (body: string, mentions: string[]) => Promise<void> | void
    placeholder?: string
}

// SuggestionReplyComposer is the reply input that sits under the
// focused-state suggestion thread. v1 reuses the shared CommentComposer
// + MentionInput primitive from @tinycld/core/ui/comments rather than
// re-implementing the @-mention autocomplete from scratch — those
// components already render the dropdown, insert `[[@userOrgId]]` wire
// tokens, and integrate with react-hook-form's submit cycle.
//
// The CommentComposer's onSubmit hands us the raw body string. We then
// call `parseMentions` (core/lib/comments/mentions.ts) on the body to
// extract the embedded user_org ids and pass `(body, mentions[])` to
// our consumer. Splitting that mapping here (rather than at the
// useSuggestionDiscussion level) keeps the discussion adapter
// agnostic of the body wire format — it still receives the parsed
// list and writes one comment_mentions row per id, mirroring the
// regular comment-thread mutation pipeline.
//
// The picker pool comes from useMentionSuggestions, which returns the
// org's user_orgs minus the current user. The current user_org id is
// pulled from useEditorMount() — the same context that the editor +
// suggestion bridge run in, so this composer can only mount inside a
// document screen.
//
// Submit-in-flight state is held locally via useState. The composer
// disables the inner submit button while the parent's onSubmit is
// pending so rapid double-presses can't fire two inserts. The local
// flag is also used to communicate the busy state visually.
export function SuggestionReplyComposer({
    onSubmit,
    placeholder = 'Reply or add others with @',
}: SuggestionReplyComposerProps) {
    const { identity } = useEditorMount()
    const currentUserOrgId = identity.userOrgId ?? ''
    const mentionSuggestions = useMentionSuggestions(currentUserOrgId)
    const [isPending, setIsPending] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const handleSubmit = useCallback(
        async (body: string) => {
            if (isPending) return
            setError(null)
            const parsed = parseMentions(body)
            const mentions = parsed.map(m => m.userOrgId)
            setIsPending(true)
            try {
                await onSubmit(body, mentions)
            } catch (e) {
                setError(e instanceof Error ? e.message : 'Failed to reply')
            } finally {
                setIsPending(false)
            }
        },
        [isPending, onSubmit]
    )

    return (
        <View>
            <CommentComposer
                placeholder={placeholder}
                submitLabel="Reply"
                isPending={isPending}
                error={error}
                onSubmit={handleSubmit}
                mentionSuggestions={mentionSuggestions}
                submitOnEnter
            />
        </View>
    )
}
