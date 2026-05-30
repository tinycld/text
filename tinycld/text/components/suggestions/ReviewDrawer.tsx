import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import type { Editor } from '@tiptap/react'
import { useEffect, useState } from 'react'
import { Platform, Pressable, ScrollView, Text, View } from 'react-native'
import type * as Y from 'yjs'
import { useStore } from 'zustand'
import { useActivityEntries } from '../../hooks/use-activity-entries'
import { useClientAuthors } from '../../hooks/use-client-authors'
import type { AnchoredSuggestion, OrphanedSuggestion } from '../../hooks/use-document-suggestions'
import type { ReviewDrawerStore } from '../../stores/review-drawer-store'
import { ActivityTab } from './ActivityTab'
import { AuthorshipTab } from './AuthorshipTab'
import { SuggestionRow } from './SuggestionRow'

type ReviewDrawerTab = 'suggestions' | 'activity' | 'authorship'

export interface ReviewDrawerProps {
    driveItemId: string
    // authorUserOrgId is the current user's user_org id; threaded into
    // each <SuggestionRow /> for the focused-state thread body (the
    // discussion adapter writes text_comments rows authored by this id).
    // Optional so existing tests that don't exercise the focused panel
    // can omit it; an empty string is safe — the discussion adapter
    // only fires its insert mutation when a focused suggestion exists,
    // and any focus-driven write requires the screen to have wired a
    // real id by then.
    authorUserOrgId?: string
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
    // Phase 3b: the Activity tab observes the doc's editEvents Y.Array
    // and the resolved-suggestions slice of the Y.Map. Both arrive
    // through the same yDoc + editor pair the suggestion bridge already
    // uses. They're optional so existing call sites (and tests) that
    // only care about the Suggestions tab don't have to plumb them
    // through; when absent the Activity tab simply has no data, and
    // the tab control hides itself.
    yDoc?: Y.Doc | null
    editor?: Editor | null
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
    authorUserOrgId = '',
    store,
    anchored,
    // orphaned is part of the prop shape for backward compatibility
    // with existing call sites + tests; the drawer no longer renders
    // it (the parent's useDocumentSuggestions auto-deletes orphans
    // before they reach the bridge / drawer). Underscore-prefixed so
    // biome's noUnusedFunctionParameters stays quiet.
    orphaned: _orphaned,
    canResolve,
    isPending,
    onAccept,
    onReject,
    onBulkAccept,
    onBulkReject,
    onJump,
    yDoc,
    // editor is part of the prop shape for the same backward-compat
    // reason — the drawer's only consumer was the Activity tab merging
    // resolved suggestions, which is gone now.
    editor: _editor,
}: ReviewDrawerProps) {
    const isOpen = useStore(store, s => s.isOpen)
    const openForId = useStore(store, s => s.driveItemId)
    const focusedId = useStore(store, s => s.focusedSuggestionId)
    const close = store.getState().close
    const fg = useThemeColor('foreground')
    const muted = useThemeColor('muted-foreground')
    const bg = useThemeColor('background')
    const border = useThemeColor('border')
    const primary = useThemeColor('primary')

    // ESC clears the focused-suggestion state so the user can collapse
    // the open thread without resorting to clicking another row. Web
    // only — native uses a bottom sheet (Task 5) whose own dismiss
    // gesture is the equivalent affordance. Bound to document keydown
    // rather than the drawer's container so the shortcut works even
    // when focus is inside the reply composer.
    const drawerIsOpenForThisDoc = isOpen && openForId === driveItemId
    useEffect(() => {
        if (Platform.OS !== 'web') return
        if (typeof document === 'undefined') return
        if (!drawerIsOpenForThisDoc) return
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return
            // Only consume the keystroke when there's something focused
            // to clear. Without the guard, ESC would silently no-op
            // every time it fires; with the guard, other ESC handlers
            // (e.g. closing a popover) still get a shot at the event.
            const state = store.getState()
            if (state.focusedSuggestionId === null) return
            state.focusSuggestion(null)
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
    }, [drawerIsOpenForThisDoc, store])
    // Active tab. Defaults to Suggestions (the established Phase 2b
    // surface) so opening the drawer behaves identically for users who
    // never touch the Activity tab. Local state — there's no reason
    // to persist this across sessions or share it with other drawers.
    const [activeTab, setActiveTab] = useState<ReviewDrawerTab>('suggestions')
    // The Activity + Authorship tabs are web-only for Phase 3b/3c. On
    // native tiptapEditor is null (the WebView owns the editor) and
    // neither the editEvents pipeline nor the authorship walker have
    // been wired through the WebView bridge — the specs explicitly
    // defer both. Hide both tab controls on native so the drawer reads
    // as Suggestions-only there.
    const showExtendedTabs = Platform.OS === 'web' && yDoc != null

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
                {showExtendedTabs ? (
                    <View style={{ flexDirection: 'row', gap: 4 }}>
                        <TabButton
                            label="Suggestions"
                            isActive={activeTab === 'suggestions'}
                            activeColor={primary}
                            inactiveColor={muted}
                            onPress={() => setActiveTab('suggestions')}
                        />
                        <TabButton
                            label="Activity"
                            isActive={activeTab === 'activity'}
                            activeColor={primary}
                            inactiveColor={muted}
                            onPress={() => setActiveTab('activity')}
                        />
                        <TabButton
                            label="Authorship"
                            isActive={activeTab === 'authorship'}
                            activeColor={primary}
                            inactiveColor={muted}
                            onPress={() => setActiveTab('authorship')}
                        />
                    </View>
                ) : (
                    <Text style={{ color: fg, fontSize: 16, fontWeight: '600' }}>Suggestions</Text>
                )}
                <Pressable
                    onPress={close}
                    accessibilityRole="button"
                    accessibilityLabel="Close drawer"
                >
                    <Text style={{ color: fg, fontSize: 18 }}>×</Text>
                </Pressable>
            </View>

            {showExtendedTabs && activeTab === 'activity' ? (
                <ActivityTabContainer yDoc={yDoc ?? null} />
            ) : showExtendedTabs && activeTab === 'authorship' ? (
                <AuthorshipTabContainer yDoc={yDoc ?? null} />
            ) : (
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
                        {openAnchored.length === 0 && (
                            <Text style={{ color: muted, padding: 12 }}>
                                No suggestions in this document.
                            </Text>
                        )}
                        {openAnchored.map(s => (
                            <SuggestionRow
                                key={`${s.id}-${s.kind}`}
                                suggestion={s}
                                driveItemId={driveItemId}
                                authorUserOrgId={authorUserOrgId}
                                isFocused={s.id === focusedId}
                                canResolve={canResolve}
                                isPending={isPending}
                                onAccept={() => onAccept(s.id)}
                                onReject={() => onReject(s.id)}
                                onFocus={() => store.getState().focusSuggestion(s.id)}
                                onJump={() => onJump(s)}
                            />
                        ))}
                        {/* Orphaned suggestions were entries in the Y.Map */}
                        {/* with no doc anchor (Accept / Reject had nothing */}
                        {/* to operate on). useDocumentSuggestions now auto- */}
                        {/* deletes them on observation so they never reach */}
                        {/* the drawer; this section has been removed. */}
                    </ScrollView>
                </View>
            )}
        </View>
    )
}

// TabButton is a header tab. Active tab gets the primary-color text +
// an underline; inactive uses muted-foreground with no accent. Two
// pressables side-by-side at the top of the drawer — the visual
// language matches the rest of the suggestions/ surface (themed colors
// via useThemeColor, inline styles, no design-system primitive).
interface TabButtonProps {
    label: string
    isActive: boolean
    activeColor: string
    inactiveColor: string
    onPress: () => void
}

function TabButton({ label, isActive, activeColor, inactiveColor, onPress }: TabButtonProps) {
    return (
        <Pressable
            onPress={onPress}
            accessibilityRole="tab"
            accessibilityLabel={label}
            accessibilityState={{ selected: isActive }}
            style={{
                paddingVertical: 6,
                paddingHorizontal: 8,
                borderBottomWidth: 2,
                borderBottomColor: isActive ? activeColor : 'transparent',
            }}
        >
            <Text
                style={{
                    color: isActive ? activeColor : inactiveColor,
                    fontSize: 14,
                    fontWeight: isActive ? '600' : '500',
                }}
            >
                {label}
            </Text>
        </Pressable>
    )
}

// ActivityTabContainer isolates the useActivityEntries call to a child
// component so the hook only runs when the Activity tab is mounted.
// Calling it at the ReviewDrawer top level would subscribe to the
// editEvents Y.Array unconditionally, including while the user is on
// the Suggestions tab — wasteful.
interface ActivityTabContainerProps {
    yDoc: Y.Doc | null
}

function ActivityTabContainer({ yDoc }: ActivityTabContainerProps) {
    const entries = useActivityEntries(yDoc)
    return <ActivityTab entries={entries} />
}

// AuthorshipTabContainer isolates the useClientAuthors subscription to a
// child component so the hook only observes the doc's `clientAuthors`
// Y.Map while the Authorship tab is mounted. Same scoping pattern as
// ActivityTabContainer — calling useClientAuthors at the ReviewDrawer
// top level would double up on the editor-level subscription that
// use-document-editor.web already installs to drive the decoration
// extension.
interface AuthorshipTabContainerProps {
    yDoc: Y.Doc | null
}

function AuthorshipTabContainer({ yDoc }: AuthorshipTabContainerProps) {
    const clientAuthors = useClientAuthors(yDoc)
    return <AuthorshipTab yDoc={yDoc} clientAuthors={clientAuthors} />
}
