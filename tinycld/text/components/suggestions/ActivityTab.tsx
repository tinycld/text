import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { ScrollView, Text, View } from 'react-native'
import type { ActivityEntry } from '../../hooks/use-activity-entries'
import { useAuthorName } from '../../hooks/use-author-name'
import { colorForUser } from '../../lib/color-for-user'
import { formatRelative } from '../../lib/format-relative'

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
    return `e:${entry.event.clientId}:${entry.event.endedAt}`
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
    const authorId = entry.event.authorId
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
    const { editCount } = entry.event
    return `${who} made ${editCount} edit${editCount === 1 ? '' : 's'}`
}
