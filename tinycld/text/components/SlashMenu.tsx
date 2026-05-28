import type { Editor } from '@tiptap/core'
import { useMemo } from 'react'
import { Platform } from 'react-native'
import type * as Y from 'yjs'
import { useResolveSuggestion } from '../hooks/use-resolve-suggestion'
import {
    AnchoredOverlayController,
    type AnchoredOverlayProps,
    type AnchoredOverlayRegistry,
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

interface SlashMenuProps {
    webViewRef: React.RefObject<unknown> | null
    // The Tiptap editor that owns the document. On native this is null
    // (the WebView owns the editor); the suggestion-popover registry
    // entry passes it through to useResolveSuggestion, which no-ops
    // when null. Wired here so a single mount site decides whether the
    // popover can apply resolutions locally vs. punt to a WebView
    // message round-trip in a future phase.
    editor: Editor | null
    // The room's Y.Doc. acceptSuggestion / rejectSuggestion both
    // mutate the suggestions Y.Map directly to flip status from
    // pending → accepted/rejected; we thread it through to the
    // popover wrapper so the resolve hook can pass it down.
    yDoc: Y.Doc | null
    // Whether the current viewer can resolve suggestions. Sourced
    // from useSuggestionPermissions at the screen level; the popover
    // hides Accept/Reject when false and shows the pending message.
    canResolve: boolean
}

// SuggestionPopoverContainer — bridges the registry's
// (payload, respond) shape with the host-side concerns the popover
// needs (the resolve mutations + the role gate). The registry callback
// is a fresh wrapper closure per registry build; this component is
// the closure body, mounted by the controller when a 'suggestion'
// kind popover is opened.
function SuggestionPopoverContainer({
    payload,
    respond,
    editor,
    yDoc,
    canResolve,
}: AnchoredOverlayProps & {
    editor: Editor | null
    yDoc: Y.Doc | null
    canResolve: boolean
}) {
    const suggestionId = (payload as { suggestionId?: string } | null)?.suggestionId ?? ''
    const { accept, reject, isPending } = useResolveSuggestion(suggestionId, {
        editor,
        yDoc,
    })

    return (
        <SuggestionPopover
            payload={payload}
            respond={respond}
            canResolve={canResolve}
            isPending={isPending}
            onAccept={async () => {
                await accept()
                respond('select', { resolution: 'accept', suggestionId })
            }}
            onReject={async () => {
                await reject()
                respond('select', { resolution: 'reject', suggestionId })
            }}
        />
    )
}

export function SlashMenu({ webViewRef, editor, yDoc, canResolve }: SlashMenuProps) {
    // Build the registry as a closure capturing the host-side props
    // the suggestion body needs. useMemo keeps the identity stable
    // across renders that don't change the inputs — useEffect deps
    // inside the controller subscribe to bus messages once, not per
    // render, so registry identity churn would be wasted work.
    const registry = useMemo<AnchoredOverlayRegistry>(
        () => ({
            'slash-menu': SlashMenuPopover,
            suggestion: (props: AnchoredOverlayProps) => (
                <SuggestionPopoverContainer
                    {...props}
                    editor={editor}
                    yDoc={yDoc}
                    canResolve={canResolve}
                />
            ),
        }),
        [editor, yDoc, canResolve]
    )

    if (Platform.OS === 'web') return null
    return <AnchoredOverlayController webViewRef={webViewRef} registry={registry} />
}
