import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { X } from 'lucide-react-native'
import { Pressable, Text, View } from 'react-native'
import { useAuthorName } from '../../hooks/use-author-name'
import type { ContributorSummary } from '../../lib/authorship/aggregate-contributors'
import { colorForUser } from '../../lib/color-for-user'

export interface AuthorshipPopoverProps {
    isOpen: boolean
    // Absolute pixel position of the popover's top-left corner. Provided
    // by the screen-level right-click handler (Task 10) which captures
    // the click coordinates and offsets them so the popover doesn't
    // cover the targeted paragraph. Null when the popover is closed.
    position: { x: number; y: number } | null
    contributors: ContributorSummary[]
    onClose: () => void
}

// AuthorshipPopover is the paragraph-level blame surface. Rendered
// absolute-positioned by the screen-level right-click handler near the
// targeted paragraph (web only — native gets a long-press affordance in
// a later phase). Closed by tapping the X icon; the screen owns dismiss-
// on-outside-click via the same useEffect that opens it.
//
// Layout mirrors ActivityRow: avatar chip (colored by colorForUser) on
// the left, name + percentage on the right. Anonymous contributors
// (authorId === null) render with a neutral chip color and the literal
// label "Anonymous" — the chip stays visible so the row still reads as
// a row, not just empty space.
//
// Visual language matches the rest of suggestions/ (themed colors via
// useThemeColor + inline style props, no className). data-testid is
// included on the root so Phase 3c e2e (when written) can locate the
// popover without coupling to DOM structure.
export function AuthorshipPopover({
    isOpen,
    position,
    contributors,
    onClose,
}: AuthorshipPopoverProps) {
    const fg = useThemeColor('foreground')
    const muted = useThemeColor('muted-foreground')
    const bg = useThemeColor('background')
    const border = useThemeColor('border')

    if (!isOpen || position === null) return null

    return (
        <View
            // React Native's View type doesn't include the web-only
            // data-* attributes, but react-native-web threads any
            // unknown DOM attrs through to the underlying element.
            // Casting to a small record-shaped object keeps the prop
            // typed without reaching for any.
            {...({ 'data-testid': 'authorship-popover' } as Record<string, string>)}
            style={{
                position: 'absolute',
                left: position.x,
                top: position.y,
                minWidth: 220,
                maxWidth: 320,
                backgroundColor: bg,
                borderWidth: 1,
                borderColor: border,
                borderRadius: 6,
                padding: 8,
                zIndex: 200,
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.15,
                shadowRadius: 6,
                elevation: 4,
            }}
        >
            <View
                style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    paddingBottom: 6,
                    borderBottomWidth: 1,
                    borderBottomColor: border,
                    marginBottom: 6,
                }}
            >
                <Text style={{ color: fg, fontSize: 13, fontWeight: '600' }}>Contributors</Text>
                <Pressable
                    onPress={onClose}
                    accessibilityRole="button"
                    accessibilityLabel="Close authorship popover"
                    style={{ padding: 2 }}
                >
                    <X size={14} color={fg} />
                </Pressable>
            </View>
            {contributors.length === 0 ? (
                <Text style={{ color: muted, fontSize: 12 }}>
                    No authors detected for this paragraph.
                </Text>
            ) : (
                <View style={{ gap: 4 }}>
                    {contributors.map(c => (
                        <ContributorRow key={c.authorId ?? '__anon__'} contributor={c} />
                    ))}
                </View>
            )}
        </View>
    )
}

interface ContributorRowProps {
    contributor: ContributorSummary
}

// ContributorRow renders one contributor: avatar chip + name + (N%).
// The avatar uses colorForUser(authorId ?? 'anon') so anonymous rows
// get a stable neutral-but-distinct color (the colorForUser helper
// hashes the input — 'anon' is just a stable sentinel input). Initials
// fall back to '?' when the name hasn't resolved yet so the chip never
// renders empty.
function ContributorRow({ contributor }: ContributorRowProps) {
    const fg = useThemeColor('foreground')
    const muted = useThemeColor('muted-foreground')
    const resolvedName = useAuthorName(contributor.authorId)
    const displayName = contributor.authorId === null ? 'Anonymous' : (resolvedName ?? 'Unknown')
    const chipColor = colorForUser(contributor.authorId ?? 'anon')
    const initials = (contributor.authorId === null ? 'A' : (resolvedName ?? '?'))
        .slice(0, 2)
        .toUpperCase()

    return (
        <View
            style={{
                flexDirection: 'row',
                gap: 8,
                alignItems: 'center',
            }}
        >
            <View
                style={{
                    width: 20,
                    height: 20,
                    borderRadius: 10,
                    backgroundColor: chipColor,
                    alignItems: 'center',
                    justifyContent: 'center',
                }}
            >
                <Text style={{ color: '#ffffff', fontSize: 9, fontWeight: '600' }}>{initials}</Text>
            </View>
            <Text style={{ color: fg, fontSize: 12, flex: 1 }} numberOfLines={1}>
                {displayName}
            </Text>
            <Text style={{ color: muted, fontSize: 12 }}>({contributor.percent}%)</Text>
        </View>
    )
}
