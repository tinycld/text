import { useEditorMount } from '@tinycld/core/lib/editor/editor-mount'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { Check, X } from 'lucide-react-native'
import { Pressable, Text, View } from 'react-native'
import type { AnchoredSuggestion } from '../../hooks/use-document-suggestions'
import { summarizeBlockChange, summarizeFormatChange } from '../../lib/suggestions/decorations'
import { useSuggestionDiscussion } from '../../lib/suggestions/discussions'
import { SuggestionReplyComposer } from './SuggestionReplyComposer'
import { SuggestionReplyList } from './SuggestionReplyList'

export interface SuggestionThreadProps {
    suggestion: AnchoredSuggestion
    driveItemId: string
    authorUserId: string
    canResolve: boolean
    onAccept: () => void
    onReject: () => void
}

// summarizeForThread composes the single-line description shown
// underneath the row header in the focused panel. The four kinds map as:
//   - insert  → "Add: '<snippet>'"
//   - delete  → "Delete: '<snippet>'"
//   - format-change / block-change / cell-change → reuse the existing
//     summarize* helpers from lib/suggestions/decorations.ts that the
//     drawer row already renders ("add bold", "change to heading 2",
//     "delete cell"). Keeping the wording identical means the focused
//     panel doesn't introduce a third independent copy strand.
//
// Returns null only when a Phase 5 kind is missing one of the
// before/after payloads it needs — in practice the doc parser always
// fills them in, so the null branch is defensive.
function summarizeForThread(suggestion: AnchoredSuggestion): string | null {
    if (suggestion.kind === 'insert') return `Add: '${suggestion.snippet}'`
    if (suggestion.kind === 'delete') return `Delete: '${suggestion.snippet}'`
    if (suggestion.kind === 'format-change') {
        const before = suggestion.beforeMarks ?? []
        const after = suggestion.afterMarks ?? []
        return summarizeFormatChange(before, after)
    }
    const before = suggestion.beforeBlock
    const after = suggestion.afterBlock
    if (!before || !after) return null
    return summarizeBlockChange(before, after)
}

// SuggestionThread is the focused-state body that sits underneath a
// suggestion row's static header. Composition:
//   - top toolbar: Accept / Reject icon buttons (only when canResolve)
//   - summary line: short description of the proposed change
//   - reply list: prior discussion (avatar + name + time + body)
//   - composer: free-text + @mention input that calls addReply
//
// Subscribes to useSuggestionDiscussion for the read+write hook pair.
// The hook itself short-circuits when suggestionId is null, but this
// component always receives a concrete suggestion — there's no path
// where it mounts without one — so the live query always fires.
//
// data-testid="suggestion-thread" is the scope hook for the
// suggestion-thread-flow e2e spec (Task 7). It pins to the root View
// so the spec can scope assertions to "the focused thread" without
// risking false positives from the drawer-level list.
export function SuggestionThread({
    suggestion,
    driveItemId,
    authorUserId,
    canResolve,
    onAccept,
    onReject,
}: SuggestionThreadProps) {
    const fg = useThemeColor('foreground')
    const muted = useThemeColor('muted-foreground')
    const primary = useThemeColor('primary')
    const border = useThemeColor('border')

    // Resolve the current user's display name once at the thread level
    // and pass it down to the discussion adapter so the inserted
    // text_comments row carries a non-empty `author_name` (required by
    // the PB schema; an empty string fails the insert silently).
    const { identity } = useEditorMount()
    const { replies, addReply } = useSuggestionDiscussion(
        suggestion.id,
        driveItemId,
        authorUserId,
        identity.displayName
    )
    const summary = summarizeForThread(suggestion)

    return (
        <View
            // React Native's View types don't recognize data-* attributes.
            // On web they pass through to the DOM so Playwright can target them.
            {...({ 'data-testid': 'suggestion-thread' } as Record<string, string>)}
            style={{
                gap: 8,
                padding: 8,
                borderTopWidth: 1,
                borderTopColor: border,
            }}
        >
            {canResolve && (
                <View
                    style={{
                        flexDirection: 'row',
                        justifyContent: 'flex-end',
                        gap: 4,
                    }}
                >
                    <Pressable
                        onPress={onAccept}
                        style={{
                            padding: 6,
                            borderRadius: 4,
                            borderWidth: 1,
                            borderColor: primary,
                        }}
                        accessibilityRole="button"
                        accessibilityLabel="Accept suggestion"
                    >
                        <Check size={16} color={primary} />
                    </Pressable>
                    <Pressable
                        onPress={onReject}
                        style={{
                            padding: 6,
                            borderRadius: 4,
                            borderWidth: 1,
                            borderColor: muted,
                        }}
                        accessibilityRole="button"
                        accessibilityLabel="Reject suggestion"
                    >
                        <X size={16} color={muted} />
                    </Pressable>
                </View>
            )}
            {summary && (
                <Text style={{ color: fg, fontSize: 13 }} numberOfLines={3}>
                    {summary}
                </Text>
            )}
            <SuggestionReplyList replies={replies} />
            <SuggestionReplyComposer onSubmit={addReply} />
        </View>
    )
}
