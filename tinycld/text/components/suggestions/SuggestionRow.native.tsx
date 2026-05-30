import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { type LucideIcon, Minus, Pencil, Plus } from 'lucide-react-native'
import { Pressable, Text, View } from 'react-native'
import { useAuthorName } from '../../hooks/use-author-name'
import type { AnchoredSuggestion } from '../../hooks/use-document-suggestions'
import { colorForUser } from '../../lib/color-for-user'
import { formatRelative } from '../../lib/format-relative'
import { summarizeBlockChange, summarizeFormatChange } from '../../lib/suggestions/decorations'

export interface SuggestionRowProps {
    suggestion: AnchoredSuggestion
    // driveItemId + authorUserOrgId are kept in the prop shape for
    // symmetry with the web variant. The native row doesn't render
    // <SuggestionThread /> inline — the screen-scoped
    // <SuggestionThreadSheet /> renders the thread body in an
    // Actionsheet — so neither identifier is read here, but
    // round-tripping them through the contract lets ReviewDrawer's
    // call site stay identical across platforms.
    driveItemId: string
    authorUserOrgId: string
    isFocused: boolean
    canResolve: boolean
    isPending: boolean
    // onAccept / onReject are also kept for symmetry. Accept / Reject
    // affordances live inside <SuggestionThread />, which the screen-
    // scoped sheet renders — the row itself never invokes either.
    onAccept: () => void
    onReject: () => void
    // Tapping the row calls onFocus. The drawer maps this to
    // reviewDrawerStore.focusSuggestion(id); the screen's mounted
    // <SuggestionThreadSheet /> reacts and rises.
    onFocus: () => void
    // onJump is optional and accepted purely for prop-shape parity
    // with the web variant. Native has no "scroll the editor to the
    // mark" affordance — the editor lives inside a WebView — so the
    // native row never invokes it. Marked optional so unit tests can
    // omit it.
    onJump?: () => void
}

// summarizeSuggestion composes the "Proposed: …" line shown beneath
// the snippet for Phase 5 kinds (format-change / block-change /
// cell-change). insert/delete return null and the row falls back to
// the existing "Added/Removed by" line, matching the web variant
// verbatim. Inlined rather than lifted to a shared helper because
// the existing platform-split pattern in this codebase (see
// use-suggestion-bridge.web.ts / .native.ts) shares types via a
// .d.ts and inlines the rest — duplication here is ~30 lines and
// keeps each variant self-contained.
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
// chip on the left of the row.
function kindIconFor(kind: AnchoredSuggestion['kind']): LucideIcon {
    if (kind === 'insert') return Plus
    if (kind === 'delete') return Minus
    return Pencil
}

// kindLabelFor renders the author-attribution line.
function kindLabelFor(kind: AnchoredSuggestion['kind']): string {
    if (kind === 'insert') return 'Added'
    if (kind === 'delete') return 'Removed'
    if (kind === 'format-change') return 'Format change'
    if (kind === 'cell-change') return 'Cell change'
    return 'Block change'
}

// SuggestionRow (native) renders ONLY the row header. The focused-
// state thread body (replies, composer, Accept / Reject) lives in
// a screen-scoped <SuggestionThreadSheet /> Actionsheet that rises
// when this row's id matches reviewDrawerStore.focusedSuggestionId.
//
// Visual style mirrors the web header verbatim: avatar (kind icon in
// the author's color) + name + relative timestamp + snippet + the
// optional "Proposed: …" summary + "Added/Removed/… by <name>"
// attribution. The isFocused accent background still applies so users
// see which row's sheet is open while the sheet is up.
//
// Tap behavior: pressing the row calls onFocus(), which the drawer
// maps to reviewDrawerStore.focusSuggestion(s.id). The screen-scoped
// sheet observes the store and renders the matching suggestion's
// thread body. There is no onJump path on native — the editor lives
// inside a WebView and host-side scrolling doesn't apply.
export function SuggestionRow({
    suggestion,
    // driveItemId, authorUserOrgId, canResolve, isPending, onAccept,
    // onReject, and onJump are accepted for prop-shape parity with the
    // web variant but unused on native — the screen-scoped sheet owns
    // those affordances. Underscore-prefixed so biome's
    // noUnusedFunctionParameters stays quiet.
    driveItemId: _driveItemId,
    authorUserOrgId: _authorUserOrgId,
    isFocused,
    canResolve: _canResolve,
    isPending: _isPending,
    onAccept: _onAccept,
    onReject: _onReject,
    onFocus,
    onJump: _onJump,
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
    const authorName = useAuthorName(suggestion.authorId) ?? suggestion.authorId

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
        </View>
    )
}
