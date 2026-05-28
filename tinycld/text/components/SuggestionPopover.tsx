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
//
// The host wrapper owns the mutation lifecycle via useResolveSuggestion
// (see hooks/use-resolve-suggestion.ts); this component just renders
// the buttons and forwards presses. Keeping the mutation outside makes
// the popover unit-testable without standing up a QueryClient and
// keeps SuggestionPopover focused on layout + a11y.
export interface SuggestionPopoverHostProps {
    // Whether the current viewer can resolve (accept / reject)
    // suggestions. The screen-level mount sources this from
    // useSuggestionPermissions; when false, only the pending message
    // shows and the buttons are hidden.
    canResolve: boolean
    // Called when the viewer taps Accept. The host wrapper builds this
    // around useResolveSuggestion(suggestionId).accept and forwards
    // any popover-result dispatch (closing the overlay) afterwards.
    onAccept: () => void | Promise<void>
    // Symmetric counterpart to onAccept for the Reject path.
    onReject: () => void | Promise<void>
    // True while a resolve mutation is in flight. Both buttons are
    // disabled during the pending window so the viewer can't fire a
    // second mutation against the same suggestion while the first
    // hasn't applied — the resolve functions are idempotent against
    // the mark structure, but the Y.Map update double-stamps the
    // resolution and would leak history.
    isPending: boolean
}

// SuggestionPopover — the native body for the anchored-overlay
// registry's 'suggestion' kind. The controller positions and frames
// us; we render Accept / Reject buttons when the viewer can resolve,
// or a pending message otherwise. Both branches call respond('dismiss')
// from the host wrapper so the controller closes the popover and posts
// popover-result back to the WebView (which clears its currentRequestId
// — see lib/suggestions/popover.ts).
//
// Backdrop taps already route through the controller's dismissExternal
// path without coming through this body, so the only path through this
// component is button presses or programmatic close from outside.
export function SuggestionPopover({
    payload,
    canResolve,
    onAccept,
    onReject,
    isPending,
}: AnchoredOverlayProps & SuggestionPopoverHostProps) {
    const suggestionId = (payload as SuggestionPopoverPayload | null)?.suggestionId ?? ''

    return (
        <View
            className="rounded-lg border border-border bg-background p-3 shadow-lg"
            accessibilityRole="menu"
            accessibilityLabel="Suggestion actions"
        >
            {canResolve ? (
                <View className="flex-row gap-2">
                    <Button
                        onPress={() => {
                            void onAccept()
                        }}
                        disabled={isPending || !suggestionId}
                        variant="default"
                        size="sm"
                        accessibilityLabel="Accept suggestion"
                    >
                        <ButtonText>Accept</ButtonText>
                    </Button>
                    <Button
                        onPress={() => {
                            void onReject()
                        }}
                        disabled={isPending || !suggestionId}
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
