import { Button, ButtonText } from '@tinycld/core/ui/button'
import { Text, View } from 'react-native'
import type { AnchoredOverlayProps } from '../lib/anchored-overlay/anchored-overlay-controller'
import {
    type SuggestionPopoverEntry,
    summarizeSuggestionEntry,
} from '../lib/suggestions/popover-summary'

// SuggestionPopoverEntry re-exported for callers that build the
// payload (the plugin's click handler, host wrappers). The shape is
// defined in lib/suggestions/popover-summary.ts so the summary
// helper can be unit-tested without dragging the full React-Native
// component (and its Button → @gluestack-ui Flow-typed dependency
// chain) into the test environment.
export type { SuggestionPopoverEntry }

interface SuggestionPopoverPayload {
    suggestions: SuggestionPopoverEntry[]
}

// Props the registry mount supplies on top of the wire payload. The
// AnchoredOverlayController's registry entries are
// (props: AnchoredOverlayProps) => ReactNode — so to thread host-side
// state (canResolve, the resolve callbacks) into the body we wrap the
// body in a host-side closure that captures them. The SlashMenu host
// mount (components/SlashMenu.tsx) builds this closure when it
// registers the 'suggestion' kind.
//
// The host wrapper owns the mutation lifecycle via
// useResolveSuggestionService (see hooks/use-resolve-suggestion.ts);
// this component just renders the rows and forwards presses. Keeping
// the mutation outside makes the popover unit-testable without
// standing up a QueryClient and keeps SuggestionPopover focused on
// layout + a11y.
export interface SuggestionPopoverHostProps {
    // Whether the current viewer can resolve (accept / reject)
    // suggestions. The screen-level mount sources this from
    // useSuggestionPermissions; when false, only the pending message
    // shows and the buttons are hidden.
    canResolve: boolean
    // Called when the viewer taps Accept on a specific row. The host
    // wrapper builds this around useResolveSuggestionService.accept
    // and forwards any popover-result dispatch (closing the overlay)
    // afterwards.
    onAccept: (suggestionId: string) => void | Promise<void>
    // Symmetric counterpart to onAccept for the Reject path.
    onReject: (suggestionId: string) => void | Promise<void>
    // True while a resolve mutation is in flight. ALL row buttons are
    // disabled during the pending window so the viewer can't fire a
    // second mutation while the first hasn't applied — the resolve
    // functions are idempotent against the mark structure, but the
    // Y.Map update double-stamps the resolution and would leak
    // history. Coarse-grained gating (whole popover) is fine because
    // a typical pending window is sub-frame.
    isPending: boolean
}

// SuggestionPopover — the native body for the anchored-overlay
// registry's 'suggestion' kind. The controller positions and frames
// us; we render Accept / Reject buttons when the viewer can resolve,
// or a pending message otherwise. Backdrop taps already route through
// the controller's dismissExternal path without coming through this
// body, so the only path through this component is button presses
// or programmatic close from outside.
//
// Layered marks: when the click position has multiple overlapping
// suggestions (Case 2b/2c), we render one row per entry with a
// compact author + kind glyph + Accept/Reject set. The single-
// suggestion case still renders the same compact buttons as Phase 2a
// (no per-row header) to keep the common case visually unchanged —
// except for Phase 5 kinds (format-change/block-change/cell-change),
// where the summary line ("Proposed: add bold") is rendered above
// the buttons so the viewer knows what's being proposed before
// committing to an action.
export function SuggestionPopover({
    payload,
    canResolve,
    onAccept,
    onReject,
    isPending,
}: AnchoredOverlayProps & SuggestionPopoverHostProps) {
    const suggestions = (payload as SuggestionPopoverPayload | null)?.suggestions ?? []
    const isMulti = suggestions.length > 1
    const single = suggestions[0]
    const singleSummary = single ? summarizeSuggestionEntry(single) : null

    return (
        <View
            className="rounded-lg border border-border bg-background p-3 shadow-lg"
            accessibilityRole="menu"
            accessibilityLabel="Suggestion actions"
        >
            {canResolve ? (
                isMulti ? (
                    <View className="gap-2">
                        {suggestions.map(entry => (
                            <SuggestionPopoverRow
                                key={`${entry.id}-${entry.kind}`}
                                entry={entry}
                                isPending={isPending}
                                onAccept={onAccept}
                                onReject={onReject}
                            />
                        ))}
                    </View>
                ) : (
                    <View className="gap-2">
                        {singleSummary && (
                            <Text className="text-xs text-muted-foreground">{singleSummary}</Text>
                        )}
                        <View className="flex-row gap-2">
                            <Button
                                onPress={() => {
                                    const id = single?.id
                                    if (!id) return
                                    void onAccept(id)
                                }}
                                disabled={isPending || suggestions.length === 0}
                                variant="default"
                                size="sm"
                                accessibilityLabel="Accept suggestion"
                            >
                                <ButtonText>Accept</ButtonText>
                            </Button>
                            <Button
                                onPress={() => {
                                    const id = single?.id
                                    if (!id) return
                                    void onReject(id)
                                }}
                                disabled={isPending || suggestions.length === 0}
                                variant="outline"
                                size="sm"
                                accessibilityLabel="Reject suggestion"
                            >
                                <ButtonText>Reject</ButtonText>
                            </Button>
                        </View>
                    </View>
                )
            ) : (
                <Text className="text-sm text-muted-foreground">
                    Pending — editor role required to resolve
                </Text>
            )}
        </View>
    )
}

// Glyph for the kind column in the multi-row view. The `+` / `−`
// pair mirrors how diff tooling conventionally renders inserted vs.
// deleted text — a quick visual cue for which kind of suggestion the
// row represents without needing the full author label to be
// disambiguated. Phase 5 kinds get a stylized glyph: `~` for format/
// block/cell changes — none of them are pure additions or removals,
// so reusing `+` / `−` would mislead the reader.
function glyphForKind(kind: SuggestionPopoverEntry['kind']): string {
    if (kind === 'insert') return '+'
    if (kind === 'delete') return '−'
    return '~'
}

interface SuggestionPopoverRowProps {
    entry: SuggestionPopoverEntry
    isPending: boolean
    onAccept: (suggestionId: string) => void | Promise<void>
    onReject: (suggestionId: string) => void | Promise<void>
}

function SuggestionPopoverRow({ entry, isPending, onAccept, onReject }: SuggestionPopoverRowProps) {
    const summary = summarizeSuggestionEntry(entry)
    return (
        <View className="gap-1">
            <View className="flex-row items-center gap-2">
                <Text className="w-4 text-sm font-semibold text-foreground">
                    {glyphForKind(entry.kind)}
                </Text>
                <Text
                    className="flex-1 text-xs text-muted-foreground"
                    numberOfLines={1}
                    ellipsizeMode="tail"
                >
                    {entry.authorId}
                </Text>
                <Button
                    onPress={() => {
                        void onAccept(entry.id)
                    }}
                    disabled={isPending}
                    variant="default"
                    size="sm"
                    accessibilityLabel={`Accept ${entry.kind} suggestion by ${entry.authorId}`}
                >
                    <ButtonText>Accept</ButtonText>
                </Button>
                <Button
                    onPress={() => {
                        void onReject(entry.id)
                    }}
                    disabled={isPending}
                    variant="outline"
                    size="sm"
                    accessibilityLabel={`Reject ${entry.kind} suggestion by ${entry.authorId}`}
                >
                    <ButtonText>Reject</ButtonText>
                </Button>
            </View>
            {summary && (
                <Text
                    className="ml-6 text-xs text-muted-foreground"
                    numberOfLines={2}
                    ellipsizeMode="tail"
                >
                    {summary}
                </Text>
            )}
        </View>
    )
}
