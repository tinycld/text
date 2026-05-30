import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { useMemo } from 'react'
import { ScrollView, Switch, Text, View } from 'react-native'
import type * as Y from 'yjs'
import { useAuthorName } from '../../hooks/use-author-name'
import {
    aggregateContributors,
    type ContributorSummary,
} from '../../lib/authorship/aggregate-contributors'
import { colorForUser } from '../../lib/color-for-user'
import { useAuthorshipDisplayStore } from '../../stores/authorship-display-store'

export interface AuthorshipTabProps {
    yDoc: Y.Doc | null
    clientAuthors: Map<number, string>
}

// AuthorshipTab is the review drawer's third tab. Two sections:
//
//   1. Toggle row — "Color text by author" Switch reading + writing
//      the authorship-display Zustand store. Flipping it on rebuilds
//      the editor's decoration set (wired through use-document-editor
//      in Task 7) so each text run renders in its author's color.
//   2. Contributor summary — horizontal bar chart per author. Bars
//      are simple flex layouts: filled flex = percent, empty flex =
//      100 - percent. Avoids pulling in a charting lib for a single
//      use case.
//
// The empty state explains that authorship populates lazily as
// collaborators edit so a brand-new doc doesn't read as broken — the
// `clientAuthors` Y.Map is empty until the first stamping op fires.
//
// We compute contributors inline rather than wrapping in a custom hook
// because this is the only consumer of `aggregateContributors` in a
// React tree. Memoized on yDoc + clientAuthors so the walk only re-runs
// when the doc or author lookup changes.
export function AuthorshipTab({ yDoc, clientAuthors }: AuthorshipTabProps) {
    const coloringEnabled = useAuthorshipDisplayStore(s => s.coloringEnabled)
    const setColoringEnabled = useAuthorshipDisplayStore(s => s.setColoringEnabled)
    const fg = useThemeColor('foreground')
    const muted = useThemeColor('muted-foreground')
    const border = useThemeColor('border')

    // The TipTap Collaboration extension binds to the Y.XmlFragment named
    // 'prosemirror' (see use-document-editor.web.tsx), not 'default'. Read
    // that same fragment so the contributor walk sees the live editor
    // content.
    const contributors = useMemo(
        () =>
            yDoc !== null
                ? aggregateContributors(yDoc.getXmlFragment('prosemirror'), clientAuthors)
                : [],
        [yDoc, clientAuthors]
    )

    return (
        <ScrollView style={{ flex: 1 }}>
            <View
                style={{
                    flexDirection: 'row',
                    gap: 12,
                    padding: 12,
                    borderBottomWidth: 1,
                    borderBottomColor: border,
                    alignItems: 'center',
                }}
            >
                <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ color: fg, fontSize: 13, fontWeight: '600' }}>
                        Color text by author
                    </Text>
                    <Text style={{ color: muted, fontSize: 11 }}>
                        Highlights each text run in the contributor's color.
                    </Text>
                </View>
                <Switch
                    value={coloringEnabled}
                    onValueChange={setColoringEnabled}
                    accessibilityLabel="Color text by author"
                />
            </View>
            {contributors.length === 0 ? (
                <View style={{ padding: 16 }}>
                    <Text style={{ color: muted, fontSize: 13 }}>
                        No authorship data yet. Authorship is recorded as collaborators edit.
                    </Text>
                </View>
            ) : (
                <View style={{ padding: 12, gap: 8 }}>
                    {contributors.map(c => (
                        <ContributorBar key={c.authorId ?? '__anon__'} contributor={c} />
                    ))}
                </View>
            )}
        </ScrollView>
    )
}

interface ContributorBarProps {
    contributor: ContributorSummary
}

// ContributorBar renders one author row: avatar chip + name on the top
// line, horizontal percentage bar + numeric label on the bottom. The
// bar is a flex container — the filled half has flex equal to the
// percent and the empty remainder has flex equal to 100 - percent, so
// the visual length tracks the share without any width math. Anonymous
// authors render the same way with a sentinel color + "Anonymous"
// label.
function ContributorBar({ contributor }: ContributorBarProps) {
    const fg = useThemeColor('foreground')
    const muted = useThemeColor('muted-foreground')
    const trackBg = useThemeColor('muted')
    const resolvedName = useAuthorName(contributor.authorId)
    const displayName = contributor.authorId === null ? 'Anonymous' : (resolvedName ?? 'Unknown')
    const chipColor = colorForUser(contributor.authorId ?? 'anon')
    const initials = (contributor.authorId === null ? 'A' : (resolvedName ?? '?'))
        .slice(0, 2)
        .toUpperCase()
    // Clamp to keep the bar layout sensible: a 0% slice should still
    // render a hairline-thin filled portion so the row reads as a row,
    // and a 100% slice shouldn't blow out the trailing label.
    const filledFlex = Math.max(contributor.percent, 0)
    const emptyFlex = Math.max(100 - contributor.percent, 0)

    return (
        <View style={{ gap: 4 }}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
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
                    <Text style={{ color: '#ffffff', fontSize: 9, fontWeight: '600' }}>
                        {initials}
                    </Text>
                </View>
                <Text style={{ color: fg, fontSize: 13, flex: 1 }} numberOfLines={1}>
                    {displayName}
                </Text>
                <Text style={{ color: muted, fontSize: 12 }}>{contributor.percent}%</Text>
            </View>
            <View
                style={{
                    flexDirection: 'row',
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: trackBg,
                    overflow: 'hidden',
                }}
            >
                <View style={{ flex: filledFlex, backgroundColor: chipColor }} />
                <View style={{ flex: emptyFlex }} />
            </View>
        </View>
    )
}
