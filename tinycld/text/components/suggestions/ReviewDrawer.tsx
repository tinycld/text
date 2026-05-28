import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { useStore } from 'zustand'
import type { AnchoredSuggestion, OrphanedSuggestion } from '../../hooks/use-document-suggestions'
import type { ReviewDrawerStore } from '../../stores/review-drawer-store'
import { SuggestionRow } from './SuggestionRow'

export interface ReviewDrawerProps {
    driveItemId: string
    store: ReviewDrawerStore
    anchored: AnchoredSuggestion[]
    orphaned: OrphanedSuggestion[]
    canResolve: boolean
    isPending: boolean
    onAccept: (suggestionId: string) => void
    onReject: (suggestionId: string) => void
    onBulkAccept: (suggestionIds: string[]) => void
    onBulkReject: (suggestionIds: string[]) => void
    onJump: (suggestion: AnchoredSuggestion) => void
}

// ReviewDrawer is the right-side panel that lists the document's
// pending suggestions. It mounts at screen scope, subscribes to the
// review-drawer store, and renders null unless the store is open AND
// open for this exact driveItemId — that way switching documents
// auto-dismisses any drawer state left over from the previous doc.
//
// Sections:
//   - Open anchored suggestions (kind icon + snippet + author),
//     ordered by document position (sort handled upstream by
//     computeDocumentSuggestions).
//   - Orphaned (Y.Map entries whose marks are gone from the doc).
//
// Accept all / Reject all act on the open anchored list only. They
// are hidden when canResolve is false (viewer / suggester with no
// resolve permission) or when there are no open suggestions.
//
// Phase 2b uses a fixed-position View rather than @tinycld/core/ui/drawer
// because the core drawer primitive (CommentDrawer) is tightly coupled
// to comment-row shapes. Swapping in a more polished primitive is a
// later refinement.
export function ReviewDrawer({
    driveItemId,
    store,
    anchored,
    orphaned,
    canResolve,
    isPending,
    onAccept,
    onReject,
    onBulkAccept,
    onBulkReject,
    onJump,
}: ReviewDrawerProps) {
    const isOpen = useStore(store, s => s.isOpen)
    const openForId = useStore(store, s => s.driveItemId)
    const focusedId = useStore(store, s => s.focusedSuggestionId)
    const close = store.getState().close
    const fg = useThemeColor('foreground')
    const muted = useThemeColor('muted-foreground')
    const bg = useThemeColor('background')
    const border = useThemeColor('border')

    const drawerOpen = isOpen && openForId === driveItemId
    if (!drawerOpen) return null

    const openAnchored = anchored.filter(s => s.status === 'open')
    const openIds = openAnchored.map(s => s.id)

    return (
        <View
            // Cleared by the title + menubar + toolbar stack so the
            // OpenReviewDrawerButton stays clickable for toggle-close
            // (otherwise the drawer would cover the toolbar trigger
            // and users would have to find the × close button).
            style={{
                position: 'absolute',
                right: 0,
                top: 96,
                bottom: 0,
                width: 320,
                backgroundColor: bg,
                borderLeftWidth: 1,
                borderLeftColor: border,
                zIndex: 100,
            }}
        >
            <View
                style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    padding: 12,
                    borderBottomWidth: 1,
                    borderBottomColor: border,
                    alignItems: 'center',
                }}
            >
                <Text style={{ color: fg, fontSize: 16, fontWeight: '600' }}>Suggestions</Text>
                <Pressable
                    onPress={close}
                    accessibilityRole="button"
                    accessibilityLabel="Close drawer"
                >
                    <Text style={{ color: fg, fontSize: 18 }}>×</Text>
                </Pressable>
            </View>

            <View style={{ flex: 1, padding: 12, gap: 12 }}>
                {canResolve && openIds.length > 0 && (
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                        <Pressable
                            onPress={() => onBulkAccept(openIds)}
                            disabled={isPending}
                            style={{
                                paddingHorizontal: 12,
                                paddingVertical: 6,
                                borderRadius: 4,
                                backgroundColor: '#0a7',
                            }}
                            accessibilityRole="button"
                            accessibilityLabel="Accept all suggestions"
                        >
                            <Text style={{ color: '#fff', fontSize: 13 }}>Accept all</Text>
                        </Pressable>
                        <Pressable
                            onPress={() => onBulkReject(openIds)}
                            disabled={isPending}
                            style={{
                                paddingHorizontal: 12,
                                paddingVertical: 6,
                                borderRadius: 4,
                                borderWidth: 1,
                                borderColor: fg,
                            }}
                            accessibilityRole="button"
                            accessibilityLabel="Reject all suggestions"
                        >
                            <Text style={{ color: fg, fontSize: 13 }}>Reject all</Text>
                        </Pressable>
                    </View>
                )}
                <ScrollView style={{ flex: 1 }}>
                    {openAnchored.length === 0 && orphaned.length === 0 && (
                        <Text style={{ color: muted, padding: 12 }}>
                            No suggestions in this document.
                        </Text>
                    )}
                    {openAnchored.map(s => (
                        <SuggestionRow
                            key={`${s.id}-${s.kind}`}
                            suggestion={s}
                            isFocused={s.id === focusedId}
                            canResolve={canResolve}
                            isPending={isPending}
                            onAccept={() => onAccept(s.id)}
                            onReject={() => onReject(s.id)}
                            onJump={() => onJump(s)}
                        />
                    ))}
                    {orphaned.length > 0 && (
                        <View style={{ marginTop: 16 }}>
                            <Text
                                style={{
                                    color: muted,
                                    fontSize: 12,
                                    fontWeight: '600',
                                    paddingHorizontal: 8,
                                    paddingBottom: 4,
                                }}
                            >
                                Orphaned
                            </Text>
                            {orphaned.map(s => (
                                <View
                                    key={s.id}
                                    style={{
                                        padding: 8,
                                        flexDirection: 'row',
                                        gap: 8,
                                    }}
                                >
                                    <Text style={{ color: fg, fontSize: 13 }}>
                                        Suggestion by {s.authorId}
                                    </Text>
                                    {canResolve && (
                                        <View
                                            style={{
                                                flexDirection: 'row',
                                                gap: 4,
                                            }}
                                        >
                                            <Pressable
                                                onPress={() => onAccept(s.id)}
                                                disabled={isPending}
                                            >
                                                <Text style={{ color: fg }}>Accept</Text>
                                            </Pressable>
                                            <Pressable
                                                onPress={() => onReject(s.id)}
                                                disabled={isPending}
                                            >
                                                <Text style={{ color: fg }}>Reject</Text>
                                            </Pressable>
                                        </View>
                                    )}
                                </View>
                            ))}
                        </View>
                    )}
                </ScrollView>
            </View>
        </View>
    )
}
