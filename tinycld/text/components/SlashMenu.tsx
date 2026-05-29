import type { Editor } from '@tiptap/core'
import { useMemo } from 'react'
import { Platform } from 'react-native'
import type * as Y from 'yjs'
import {
    AnchoredOverlayController,
    type AnchoredOverlayRegistry,
} from '../lib/anchored-overlay/anchored-overlay-controller'
import { SlashMenuPopover } from './SlashMenuPopover'

// SlashMenu (native) — mounts the anchored-overlay controller and
// registers the 'slash-menu' overlay kind (typed-trigger command
// palette, lib/editor/slash-menu).
//
// Earlier phases registered a 'suggestion' kind here too — a click-
// anchored Accept/Reject popover for change-tracking decorations.
// That popover was deleted: clicking a suggestion now opens the
// review drawer focused on the matching row (see
// lib/suggestions/click-to-focus.ts + useSuggestionClickHandler in
// screens/[id].tsx). The drawer is the canonical action surface.
//
// Metro picks SlashMenu.web.tsx on web; this file is only loaded on
// native. The Platform.OS guard is a belt-and-suspenders check for the
// metro-resolver edge case where the .tsx variant gets loaded on web.

interface SlashMenuProps {
    webViewRef: React.RefObject<unknown> | null
    editor: Editor | null
    yDoc: Y.Doc | null
    // canResolve is part of the prop shape for backward compatibility
    // with the screen's call site; the suggestion popover that
    // consumed it has been deleted, so the value is now unused here.
    canResolve: boolean
}

export function SlashMenu({ webViewRef, editor: _e, yDoc: _y, canResolve: _c }: SlashMenuProps) {
    const registry = useMemo<AnchoredOverlayRegistry>(
        () => ({ 'slash-menu': SlashMenuPopover }),
        []
    )

    if (Platform.OS === 'web') return null
    return <AnchoredOverlayController webViewRef={webViewRef} registry={registry} />
}
