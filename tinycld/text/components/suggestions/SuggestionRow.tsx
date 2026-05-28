import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { Check, Minus, Plus, X } from 'lucide-react-native'
import { Pressable, Text, View } from 'react-native'
import type { AnchoredSuggestion } from '../../hooks/use-document-suggestions'
import { colorForUser } from '../../lib/color-for-user'

export interface SuggestionRowProps {
    suggestion: AnchoredSuggestion
    isFocused: boolean
    canResolve: boolean
    isPending: boolean
    onAccept: () => void
    onReject: () => void
    onJump: () => void
}

// SuggestionRow renders one entry in the review drawer's list.
// - Left: kind icon (Plus for insert, Minus for delete) in the
//   author's color
// - Center: snippet of the affected text + author label
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
    const KindIcon = suggestion.kind === 'insert' ? Plus : Minus

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
            accessibilityLabel={`Suggestion by ${suggestion.authorId}`}
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
                <Text style={{ color: muted, fontSize: 11 }}>
                    {suggestion.kind === 'insert' ? 'Added' : 'Removed'} by {suggestion.authorId}
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
