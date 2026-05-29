import { and, eq } from '@tanstack/db'
import { useStore } from '@tinycld/core/lib/pocketbase'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { useOrgLiveQuery } from '@tinycld/core/lib/use-org-live-query'
import { ScrollView, Text, View } from 'react-native'
import type { ActivityEntry } from '../../hooks/use-activity-entries'
import { colorForUser } from '../../lib/color-for-user'

export interface ActivityTabProps {
    entries: ActivityEntry[]
}

// ActivityTab is the review drawer's second tab. It renders a
// reverse-chronological list of edit events (debounced 60s windows of
// free typing) and resolved suggestions (accept/reject decisions),
// both keyed off the document the drawer is open for. The component
// is informational only — there are no resolve buttons here. Anything
// actionable lives on the Suggestions tab.
//
// The empty state explains the 60s debounce so a brand-new doc doesn't
// look broken when it shows nothing — the user did edit, the server
// just hasn't closed the window yet.
export function ActivityTab({ entries }: ActivityTabProps) {
    const muted = useThemeColor('muted-foreground')

    if (entries.length === 0) {
        return (
            <View style={{ padding: 16 }}>
                <Text style={{ color: muted, fontSize: 13 }}>
                    No activity yet. Edit events appear after a 60-second window of inactivity.
                </Text>
            </View>
        )
    }

    return (
        <ScrollView style={{ flex: 1 }}>
            {entries.map(entry => (
                <ActivityRow key={rowKey(entry)} entry={entry} />
            ))}
        </ScrollView>
    )
}

function rowKey(entry: ActivityEntry): string {
    if (entry.kind === 'edit-event') {
        return `e:${entry.event.clientId}:${entry.event.endedAt}`
    }
    return `s:${entry.suggestion.id}`
}

// ActivityRow renders one entry. Avatar (colored initials chip via
// colorForUser) on the left, summary + relative timestamp on the
// right. Mirrors SuggestionRow's gap/padding/font-size choices so the
// two tabs read as one continuous list when the user switches between
// them.
function ActivityRow({ entry }: { entry: ActivityEntry }) {
    const fg = useThemeColor('foreground')
    const muted = useThemeColor('muted-foreground')
    const border = useThemeColor('border')
    const authorId = entry.kind === 'edit-event' ? entry.event.authorId : entry.suggestion.authorId
    const authorName = useAuthorName(authorId)
    const authorColor = colorForUser(authorId)
    const initials = (authorName ?? '?').slice(0, 2).toUpperCase()

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
                <Text style={{ color: fg, fontSize: 13 }}>{summarize(entry, authorName)}</Text>
                <Text style={{ color: muted, fontSize: 11 }}>{formatRelative(entry.ts)}</Text>
            </View>
        </View>
    )
}

function summarize(entry: ActivityEntry, name: string | null): string {
    const who = name ?? 'Someone'
    if (entry.kind === 'edit-event') {
        const { editCount } = entry.event
        return `${who} made ${editCount} edit${editCount === 1 ? '' : 's'}`
    }
    const action = entry.suggestion.status === 'accepted' ? 'accepted' : 'rejected'
    return `${who} ${action} a suggestion`
}

// formatRelative renders a UNIX-millis timestamp as a human-friendly
// "N minutes ago" style string. Handles the just-now / minute / hour /
// day buckets. We deliberately avoid Intl.RelativeTimeFormat here —
// activity rows render densely, so the explicit bucketing keeps the
// strings short ("3 minutes ago" vs. "3 minutes ago" + locale-specific
// quirks) and predictable.
function formatRelative(ts: number): string {
    const minutes = Math.floor((Date.now() - ts) / 60_000)
    if (minutes < 1) return 'just now'
    if (minutes === 1) return '1 minute ago'
    if (minutes < 60) return `${minutes} minutes ago`
    const hours = Math.floor(minutes / 60)
    if (hours === 1) return '1 hour ago'
    if (hours < 24) return `${hours} hours ago`
    const days = Math.floor(hours / 24)
    return `${days} day${days === 1 ? '' : 's'} ago`
}

// Resolves the display name for a user_org id. Two-table join
// (user_org → users) so we render the human-readable name from the
// user record, falling back to the email if name is unset. Returns
// null while the query is loading or when the id doesn't resolve
// (anonymous / orphan / cross-org id), letting the row degrade to
// "Someone made N edits".
//
// We don't have a `useOrgUser` hook in this codebase yet, so we model
// the lookup after `use-mention-suggestions.ts` and inline the
// per-author query. One subscription per row is the cost — typical
// activity feeds have <100 rows and most reuse the same handful of
// authorIds, so TanStack DB's caching makes this cheap in practice.
function useAuthorName(authorId: string): string | null {
    const [userOrgCollection, usersCollection] = useStore('user_org', 'users')
    const { data: rows } = useOrgLiveQuery(
        (query, { orgId }) =>
            query
                .from({ uo: userOrgCollection })
                .join({ u: usersCollection }, ({ uo, u }) => eq(uo.user, u.id))
                .where(({ uo }) => and(eq(uo.id, authorId), eq(uo.org, orgId)))
                .select(({ u }) => ({ name: u.name, email: u.email })),
        [authorId]
    )
    const row = rows?.[0] as { name: string | null; email: string | null } | undefined
    if (!row) return null
    return row.name || row.email || null
}
