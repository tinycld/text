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

// Props the registry mount supplies on top of the wire payload.
// Kept for compatibility with existing registry closures; the popover
// body no longer consumes these fields (resolve actions live in the
// review drawer). New mounts should still pass them so a future
// recombination of the surfaces doesn't require a callsite-wide
// migration.
export interface SuggestionPopoverHostProps {
    canResolve: boolean
    onAccept: (suggestionId: string) => void | Promise<void>
    onReject: (suggestionId: string) => void | Promise<void>
    isPending: boolean
}

// SuggestionPopover — the native body for the anchored-overlay
// registry's 'suggestion' kind. Renders a compact Google-Docs-style
// summary of the suggestion(s) at the click position: author name +
// what's proposed (e.g. "Delete: 'test'", "Add: 'note this'",
// "Proposed: add bold").
//
// Intentionally READ-ONLY: no Accept / Reject buttons. The viewer
// takes action from the review drawer, which carries the full
// per-document context (other suggestions, bulk actions, author
// avatars, timestamps). Acting from an inline popover forces the
// viewer to resolve one suggestion at a time without that context,
// which is the wrong default for any non-trivial document.
//
// canResolve / onAccept / onReject / isPending props are kept on the
// host-props interface for backwards compatibility with the registry
// mount's closure but are no longer consumed here. The drawer owns the
// resolve lifecycle end-to-end.
export function SuggestionPopover({ payload }: AnchoredOverlayProps & SuggestionPopoverHostProps) {
    // Google-Docs-style tooltip: a compact, read-only summary that names
    // the author + describes the proposed change. Accept / Reject is
    // intentionally NOT here — those actions live in the review drawer
    // where the viewer sees the full suggestion set in context. A small
    // inline popover forces the viewer to act on one item at a time
    // without the doc-level overview, which is the wrong default.
    //
    // Each row corresponds to one (suggestionId, kind) pair the popover
    // plugin found at the click point. The plugin dedupes by that key
    // upstream so layered (Case 2c) marks don't multi-render here.
    const suggestions = (payload as SuggestionPopoverPayload | null)?.suggestions ?? []
    if (suggestions.length === 0) {
        return null
    }
    return (
        <View
            className="rounded-lg border border-border bg-background p-3 shadow-lg"
            accessibilityRole="summary"
            accessibilityLabel="Suggestion details"
        >
            <View className="gap-1.5">
                {suggestions.map(entry => (
                    <SuggestionPopoverRow key={`${entry.id}-${entry.kind}`} entry={entry} />
                ))}
            </View>
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
}

function SuggestionPopoverRow({ entry }: SuggestionPopoverRowProps) {
    const summary = summarizeSuggestionEntry(entry)
    return (
        <View
            // React Native's View type doesn't include the web-only
            // data-* attributes, but react-native-web threads any
            // unknown DOM attrs through to the underlying element.
            // The testid lets the popover-dedup e2e count rows
            // without coupling to the inline View/Text DOM structure.
            {...({ 'data-testid': 'suggestion-popover-row' } as Record<string, string>)}
            className="flex-row items-start gap-2"
        >
            <Text className="w-4 text-sm font-semibold text-foreground">
                {glyphForKind(entry.kind)}
            </Text>
            <View className="flex-1">
                <Text
                    className="text-xs font-medium text-foreground"
                    numberOfLines={1}
                    ellipsizeMode="tail"
                >
                    {entry.authorId}
                </Text>
                {summary && (
                    <Text
                        className="text-xs text-muted-foreground"
                        numberOfLines={2}
                        ellipsizeMode="tail"
                    >
                        {summary}
                    </Text>
                )}
            </View>
        </View>
    )
}
