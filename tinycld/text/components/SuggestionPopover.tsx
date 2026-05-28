import { Button, ButtonText } from '@tinycld/core/ui/button'
import { Text, View } from 'react-native'
import type { AnchoredOverlayProps } from '../lib/anchored-overlay/anchored-overlay-controller'

// Payload shape posted by the WebView's suggestion-popover plugin on
// show-popover (see lib/suggestions/popover.ts). Just the suggestionId
// for Task 11 — Task 13 may extend this with kind / authorId / range
// summary fields for richer popover content.
interface SuggestionPopoverPayload {
    suggestionId: string
}

// Props the registry mount supplies on top of the wire payload. The
// AnchoredOverlayController's registry entries are
// (props: AnchoredOverlayProps) => ReactNode — so to thread host-side
// state (canResolve, the resolve callbacks) into the body we wrap the
// body in a host-side closure that captures them. The SlashMenu host
// mount (components/SlashMenu.tsx) builds this closure when it
// registers the 'suggestion' kind.
export interface SuggestionPopoverHostProps {
    // Whether the current viewer can resolve (accept / reject)
    // suggestions. Phase 2a Task 11 hard-codes this to false (the
    // "pending" message renders); Task 13 wires the real value from
    // the editor-mode store + role gate. When false, only the message
    // shows and the buttons are hidden.
    canResolve: boolean
    // Called with the clicked suggestion id when the viewer taps
    // Accept. Phase 2a Task 11 supplies a no-op stub; Task 13 wires
    // this to the real resolve mutation that flips suggestion state
    // to 'accepted' and applies it to the document.
    onAccept: (suggestionId: string) => void
    // Symmetric counterpart to onAccept for the Reject path.
    onReject: (suggestionId: string) => void
}

// SuggestionPopover — the native body for the anchored-overlay
// registry's 'suggestion' kind. The controller positions and frames
// us; we render Accept / Reject buttons when the viewer can resolve,
// or a pending message otherwise. Both branches call respond('dismiss')
// internally so the controller closes the popover and posts
// popover-result back to the WebView (which clears its currentRequestId
// — see lib/suggestions/popover.ts).
//
// Backdrop taps already route through the controller's dismissExternal
// path without coming through this body, so the only path through this
// component is button presses or programmatic close from outside.
export function SuggestionPopover({
    payload,
    respond,
    canResolve,
    onAccept,
    onReject,
}: AnchoredOverlayProps & SuggestionPopoverHostProps) {
    const suggestionId = (payload as SuggestionPopoverPayload | null)?.suggestionId ?? ''

    const handleAccept = () => {
        onAccept(suggestionId)
        respond('select', { resolution: 'accept', suggestionId })
    }

    const handleReject = () => {
        onReject(suggestionId)
        respond('select', { resolution: 'reject', suggestionId })
    }

    return (
        <View
            className="rounded-lg border border-border bg-background p-3 shadow-lg"
            accessibilityRole="menu"
            accessibilityLabel="Suggestion actions"
        >
            {canResolve ? (
                <View className="flex-row gap-2">
                    <Button
                        onPress={handleAccept}
                        variant="default"
                        size="sm"
                        accessibilityLabel="Accept suggestion"
                    >
                        <ButtonText>Accept</ButtonText>
                    </Button>
                    <Button
                        onPress={handleReject}
                        variant="outline"
                        size="sm"
                        accessibilityLabel="Reject suggestion"
                    >
                        <ButtonText>Reject</ButtonText>
                    </Button>
                </View>
            ) : (
                <Text className="text-sm text-muted-foreground">
                    Pending — editor role required to resolve
                </Text>
            )}
        </View>
    )
}
