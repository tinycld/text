import { Platform } from 'react-native'
import {
    AnchoredOverlayController,
    type AnchoredOverlayProps,
} from '../lib/anchored-overlay/anchored-overlay-controller'
import { SlashMenuPopover } from './SlashMenuPopover'
import { SuggestionPopover } from './SuggestionPopover'

// SlashMenu (native) — mounts the anchored-overlay controller and
// registers both overlay kinds the text package uses:
//   - 'slash-menu'  — typed-trigger command palette (lib/editor/slash-menu)
//   - 'suggestion'  — click-anchored Accept/Reject popover for change-
//                     tracking decorations (lib/suggestions/popover)
//
// The WebView posts ui.show-popover messages for both kinds; the
// controller routes by kind into the registry. Selections / dismissals
// flow back via popover-result on the 'ui' namespace.
//
// Metro picks SlashMenu.web.tsx on web; this file is only loaded on
// native. The Platform.OS guard is a belt-and-suspenders check for the
// metro-resolver edge case where the .tsx variant gets loaded on web
// (e.g. through a test config that doesn't honor the platform suffix
// — see vitest's plain resolution).
//
// Phase 2a Task 11 hard-codes canResolve=false and stubs the resolve
// callbacks — the popover renders the "pending" message and Accept /
// Reject buttons aren't shown. Task 13 lifts canResolve + the real
// mutations into a context / store the body subscribes to.
const noopResolve = (_suggestionId: string) => {
    // Wired in Task 13 via useResolveSuggestion + role gating.
}

function SuggestionPopoverBody(props: AnchoredOverlayProps) {
    return (
        <SuggestionPopover
            {...props}
            canResolve={false}
            onAccept={noopResolve}
            onReject={noopResolve}
        />
    )
}

export function SlashMenu({ webViewRef }: { webViewRef: React.RefObject<unknown> | null }) {
    if (Platform.OS === 'web') return null
    return (
        <AnchoredOverlayController
            webViewRef={webViewRef}
            registry={{
                'slash-menu': SlashMenuPopover,
                suggestion: SuggestionPopoverBody,
            }}
        />
    )
}
