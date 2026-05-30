import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { type LucideIcon, Minus, Pencil, Plus } from 'lucide-react-native'
import { useEffect, useRef } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useAuthorName } from '../../hooks/use-author-name'
import type { AnchoredSuggestion } from '../../hooks/use-document-suggestions'
import { colorForUser } from '../../lib/color-for-user'
import { formatRelative } from '../../lib/format-relative'
import { summarizeBlockChange, summarizeFormatChange } from '../../lib/suggestions/decorations'
import { SuggestionThread } from './SuggestionThread'

export interface SuggestionRowProps {
    suggestion: AnchoredSuggestion
    // driveItemId + authorUserOrgId thread through to <SuggestionThread />
    // for the focused-state body — the discussion adapter writes
    // text_comments rows scoped to (drive_item, suggestion_id, author),
    // and the screen owns those identifiers. Plumbed down rather than
    // re-read from useEditorMount/useCurrentRole here so the row stays
    // identity-context-free and trivially mountable in unit tests.
    driveItemId: string
    authorUserOrgId: string
    isFocused: boolean
    canResolve: boolean
    isPending: boolean
    onAccept: () => void
    onReject: () => void
    // onFocus replaces the old "click → jump to mark" wiring as the
    // primary affordance. Clicking the static header now focuses the
    // row (so the thread body opens). The drawer's parent maps this to
    // reviewDrawerStore.focusSuggestion(s.id).
    onFocus: () => void
    // onJump is preserved for back-compat — the drawer still wants to
    // scroll the editor to the mark when a row first gets focused so
    // the editor surface stays in sync with the drawer. The row calls
    // onJump once per focus-edge (when isFocused transitions from
    // false → true). Marked optional so unit tests that don't care
    // about scroll behavior can omit it.
    onJump?: () => void
}

// summarizeSuggestion composes the "Proposed: …" line shown beneath
// the snippet for Phase 5 kinds (format-change / block-change /
// cell-change). insert/delete return null and the row falls back to
// the existing "Added/Removed by" line, keeping the original look
// unchanged for the two original kinds.
function summarizeSuggestion(suggestion: AnchoredSuggestion): string | null {
    if (suggestion.kind === 'insert' || suggestion.kind === 'delete') return null
    if (suggestion.kind === 'format-change') {
        const before = suggestion.beforeMarks ?? []
        const after = suggestion.afterMarks ?? []
        return `Proposed: ${summarizeFormatChange(before, after)}`
    }
    const before = suggestion.beforeBlock
    const after = suggestion.afterBlock
    if (!before || !after) return null
    return `Proposed: ${summarizeBlockChange(before, after)}`
}

// kindIconFor returns the lucide icon used in the colored author
// chip on the left of the row. insert/delete keep their plus/minus
// glyphs; Phase 5 kinds get a pencil icon — none of them are a pure
// addition or removal, so reusing those glyphs would mislead.
function kindIconFor(kind: AnchoredSuggestion['kind']): LucideIcon {
    if (kind === 'insert') return Plus
    if (kind === 'delete') return Minus
    return Pencil
}

// kindLabelFor renders the author-attribution line ("Added by uo_x",
// "Format change by uo_x", …). Same authorId on both sides; the
// verb is what differs by kind.
function kindLabelFor(kind: AnchoredSuggestion['kind']): string {
    if (kind === 'insert') return 'Added'
    if (kind === 'delete') return 'Removed'
    if (kind === 'format-change') return 'Format change'
    if (kind === 'cell-change') return 'Cell change'
    return 'Block change'
}

// SuggestionRow (web) renders one entry in the review drawer's list,
// split into:
//   - The always-visible HEADER: avatar (kind icon in the author's
//     color) + name + relative timestamp + snippet + "Proposed: …"
//     summary line + "Added/Removed/… by <name>" attribution.
//   - The focused-state BODY: when isFocused is true, renders
//     <SuggestionThread> underneath. The thread owns the Accept /
//     Reject buttons + reply composer.
//
// The header is pressable: tapping anywhere on it calls onFocus
// (which the drawer maps to reviewDrawerStore.focusSuggestion(id)).
// onJump runs once per focus-edge (false → true) so the editor scrolls
// to the matching mark when the row first gains focus. Re-tapping a
// focused row is a no-op.
//
// Task 5 (native) ships SuggestionRow.native.tsx, which renders only
// the header and opens a bottom sheet on tap. The shared thread body
// is the same component (<SuggestionThread />) — only the wrapping
// chrome differs across platforms.
export function SuggestionRow({
    suggestion,
    driveItemId,
    authorUserOrgId,
    isFocused,
    canResolve,
    isPending: _isPending,
    onAccept,
    onReject,
    onFocus,
    onJump,
}: SuggestionRowProps) {
    const fg = useThemeColor('foreground')
    const muted = useThemeColor('muted-foreground')
    const focusBg = useThemeColor('accent')
    const authorColor = colorForUser(suggestion.authorId)
    const KindIcon = kindIconFor(suggestion.kind)
    const summary = summarizeSuggestion(suggestion)
    const kindLabel = kindLabelFor(suggestion.kind)
    // Resolve the user_org id to a human name (falls back to email,
    // then null while the live query loads or for unresolved ids).
    // Until the query resolves we render the raw id so the row never
    // flashes "Loading…" — once the name lands, the row updates in
    // place. accessibilityLabel uses the resolved name when available.
    const authorName = useAuthorName(suggestion.authorId) ?? suggestion.authorId

    // Fire onJump once per focus-edge (transition from unfocused to
    // focused). A ref keeps prevFocused across renders without forcing
    // an extra re-render the way useState would. The drawer's onJump
    // typically calls editor.commands.focus(s.anchorRange.from), which
    // is fine to invoke once but wasteful to re-fire on every render
    // while the row stays focused.
    const wasFocusedRef = useRef(false)
    useEffect(() => {
        if (isFocused && !wasFocusedRef.current) {
            onJump?.()
        }
        wasFocusedRef.current = isFocused
    }, [isFocused, onJump])

    return (
        <View>
            <Pressable
                onPress={onFocus}
                style={{
                    flexDirection: 'row',
                    gap: 8,
                    padding: 8,
                    backgroundColor: isFocused ? focusBg : 'transparent',
                    alignItems: 'flex-start',
                }}
                accessibilityRole="button"
                accessibilityLabel={`Suggestion by ${authorName}`}
            >
                <View
                    style={{
                        width: 16,
                        height: 16,
                        borderRadius: 4,
                        backgroundColor: authorColor,
                        alignItems: 'center',
                        justifyContent: 'center',
                        marginTop: 2,
                    }}
                >
                    <KindIcon size={12} color="#ffffff" strokeWidth={3} />
                </View>
                <View style={{ flex: 1, gap: 4 }}>
                    <View style={{ flexDirection: 'row', gap: 6, alignItems: 'baseline' }}>
                        <Text style={{ color: fg, fontSize: 13, fontWeight: '600' }}>
                            {authorName}
                        </Text>
                        <Text style={{ color: muted, fontSize: 11 }}>
                            {formatRelative(suggestion.ts)}
                        </Text>
                    </View>
                    <Text style={{ color: fg, fontSize: 13 }} numberOfLines={2}>
                        {suggestion.snippet}
                    </Text>
                    {summary && (
                        <Text style={{ color: muted, fontSize: 12 }} numberOfLines={2}>
                            {summary}
                        </Text>
                    )}
                    <Text style={{ color: muted, fontSize: 11 }}>
                        {kindLabel} by {authorName}
                    </Text>
                </View>
            </Pressable>
            {isFocused && (
                <SuggestionThread
                    suggestion={suggestion}
                    driveItemId={driveItemId}
                    authorUserOrgId={authorUserOrgId}
                    canResolve={canResolve}
                    onAccept={onAccept}
                    onReject={onReject}
                />
            )}
        </View>
    )
}
