import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { Text, View } from 'react-native'
import { useAuthorName } from '../../hooks/use-author-name'
import { colorForUser } from '../../lib/color-for-user'
import { formatRelative } from '../../lib/format-relative'
import type { SuggestionReply } from '../../lib/suggestions/discussions'

export interface SuggestionReplyListProps {
    replies: SuggestionReply[]
}

// SuggestionReplyList renders the chronological list of prior replies
// to a single suggestion. Mirrors ActivityTab's row layout (24px avatar
// chip, gap 8, padding 8, body fontSize 13, meta fontSize 11) so the
// suggestion thread reads visually consistent with the Activity feed.
//
// Empty list collapses to nothing — the composer renders unconditionally
// below the list and carries its own placeholder, so an empty thread
// shouldn't double-stack with an "(no replies yet)" line.
//
// Body is rendered as plain text in v1. The wire format used by the
// composer is `[[@<userOrgId>]]` mention tokens (see
// core/lib/comments/mentions.ts), which surface as literal bracketed
// ids in the rendered text. Pretty rendering (turning the token into
// "@Alice") is intentionally deferred to a later pass — for v1 we
// optimize for shipping the storage + notification pipeline, not the
// rich-render layer.
export function SuggestionReplyList({ replies }: SuggestionReplyListProps) {
    if (replies.length === 0) return null

    return (
        <View>
            {replies.map(reply => (
                <ReplyRow key={reply.id} reply={reply} />
            ))}
        </View>
    )
}

// ReplyRow is one entry in the list. Avatar (initials chip in the
// author's color) on the left; name + relative time + body on the
// right. Stays a sibling of `ActivityRow` rather than a shared
// primitive — the two share visual style but ActivityRow's body is
// computed from an ActivityEntry summary while this one carries a free
// markdown-ish string. Sharing a primitive would force the union type
// down through both call sites for negligible win.
function ReplyRow({ reply }: { reply: SuggestionReply }) {
    const fg = useThemeColor('foreground')
    const muted = useThemeColor('muted-foreground')
    const border = useThemeColor('border')
    const authorName = useAuthorName(reply.authorId) ?? reply.authorId
    const authorColor = colorForUser(reply.authorId)
    const initials = authorName.slice(0, 2).toUpperCase()

    return (
        <View
            style={{
                flexDirection: 'row',
                gap: 8,
                padding: 8,
                borderBottomWidth: 1,
                borderBottomColor: border,
                alignItems: 'flex-start',
            }}
        >
            <View
                style={{
                    width: 24,
                    height: 24,
                    borderRadius: 12,
                    backgroundColor: authorColor,
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginTop: 2,
                }}
            >
                <Text style={{ color: '#ffffff', fontSize: 10, fontWeight: '600' }}>
                    {initials}
                </Text>
            </View>
            <View style={{ flex: 1, gap: 2 }}>
                <View style={{ flexDirection: 'row', gap: 6, alignItems: 'baseline' }}>
                    <Text style={{ color: fg, fontSize: 13, fontWeight: '600' }}>{authorName}</Text>
                    <Text style={{ color: muted, fontSize: 11 }}>
                        {formatRelative(reply.createdAt)}
                    </Text>
                </View>
                <Text style={{ color: fg, fontSize: 13 }}>{reply.body}</Text>
            </View>
        </View>
    )
}
