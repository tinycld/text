import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { Check, type LucideIcon, Minus, Pencil, Plus, X } from 'lucide-react-native'
import { Pressable, Text, View } from 'react-native'
import { useAuthorName } from '../../hooks/use-author-name'
import type { AnchoredSuggestion } from '../../hooks/use-document-suggestions'
import { colorForUser } from '../../lib/color-for-user'
import { summarizeBlockChange, summarizeFormatChange } from '../../lib/suggestions/decorations'

export interface SuggestionRowProps {
    suggestion: AnchoredSuggestion
    isFocused: boolean
    canResolve: boolean
    isPending: boolean
    onAccept: () => void
    onReject: () => void
    onJump: () => void
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

// SuggestionRow renders one entry in the review drawer's list.
// - Left: kind icon (Plus for insert, Minus for delete, Pencil for
//   format/block/cell changes) in the author's color
// - Center: snippet of the affected text + "Proposed: …" summary for
//   Phase 5 kinds + author attribution line
// - Right: Accept/Reject buttons (only when canResolve)
//
// The whole row is pressable — tapping anywhere outside the action
// buttons calls onJump (focus the suggestion in the editor). The
// Accept/Reject buttons stopPropagation so they don't double-fire
// onJump.
export function SuggestionRow({
    suggestion,
    isFocused,
    canResolve,
    isPending,
    onAccept,
    onReject,
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

    return (
        <Pressable
            onPress={onJump}
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
            {canResolve && (
                <View style={{ flexDirection: 'row', gap: 4 }}>
                    <Pressable
                        onPress={e => {
                            e.stopPropagation()
                            onAccept()
                        }}
                        disabled={isPending}
                        style={{ padding: 4 }}
                        accessibilityRole="button"
                        accessibilityLabel="Accept suggestion"
                    >
                        <Check size={16} color={fg} />
                    </Pressable>
                    <Pressable
                        onPress={e => {
                            e.stopPropagation()
                            onReject()
                        }}
                        disabled={isPending}
                        style={{ padding: 4 }}
                        accessibilityRole="button"
                        accessibilityLabel="Reject suggestion"
                    >
                        <X size={16} color={fg} />
                    </Pressable>
                </View>
            )}
        </Pressable>
    )
}
