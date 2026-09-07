import { Sheet } from '@tinycld/core/ui/sheet'
import { Platform } from 'react-native'
import { useStore } from 'zustand'
import type { AnchoredSuggestion } from '../../hooks/use-document-suggestions'
import type { ReviewDrawerStore } from '../../stores/review-drawer-store'
import { SuggestionThread } from './SuggestionThread'

export interface SuggestionThreadSheetProps {
    driveItemId: string
    authorUserId: string
    // anchored is the current bridge snapshot. The sheet looks up the
    // focused suggestion in this list. When the focused id has been
    // cleaned up by orphan-auto-delete or is simply not in the doc,
    // the lookup returns undefined and the sheet stays closed.
    anchored: AnchoredSuggestion[]
    canResolve: boolean
    isPending: boolean
    onAccept: (suggestionId: string) => void
    onReject: (suggestionId: string) => void
    store: ReviewDrawerStore
}

// SuggestionThreadSheet — native-only bottom sheet that rises whenever
// reviewDrawerStore.focusedSuggestionId points at a suggestion that
// exists in the current bridge snapshot. Wraps <SuggestionThread />
// (the same component the web variant of SuggestionRow renders inline
// when isFocused) so the discussion UI is identical across platforms;
// only the chrome around it differs (inline panel on web, bottom
// sheet on native).
//
// Mounted at screen scope, NOT inside the drawer — the drawer on
// native is itself the suggestions list, and the sheet must rise
// above it. Bound to the same review-drawer store the drawer uses
// for focus state so opening and closing are perfectly in sync with
// which row shows the accent-background "focused" state.
//
// Web path: returns null. The web variant of SuggestionRow renders
// <SuggestionThread /> inline in the focused-state body, so a sheet
// would be a redundant second copy. Gating on Platform.OS keeps the
// per-render cost on web a single comparison and lets the screen
// mount the component unconditionally.
//
// Dismiss flow: closing the sheet (swipe-down, backdrop tap, or the
// title row's close button) calls store.focusSuggestion(null) so the row's focus
// state clears in lockstep — leaving the row visually focused while
// the sheet is closed would be confusing.
export function SuggestionThreadSheet(props: SuggestionThreadSheetProps) {
    if (Platform.OS === 'web') return null
    return <NativeSuggestionThreadSheet {...props} />
}

function NativeSuggestionThreadSheet({
    driveItemId,
    authorUserId,
    anchored,
    canResolve,
    isPending: _isPending,
    onAccept,
    onReject,
    store,
}: SuggestionThreadSheetProps) {
    const focusedId = useStore(store, s => s.focusedSuggestionId)
    // Look up the focused suggestion in the current bridge snapshot.
    // When the id has been cleaned up by orphan-auto-delete (the Y.Map
    // row deleted because no doc anchor exists) or is otherwise not in
    // the doc, the lookup returns undefined — the sheet stays closed.
    const focused = focusedId === null ? null : anchored.find(s => s.id === focusedId)
    const isOpen = focused != null

    // Dismiss handler — also called by the backdrop tap, the drag-down
    // gesture, and the title row's close button. Clearing the store's focused id is
    // what closes the sheet on the next render; we don't track local
    // open state, so the store is the single source of truth.
    const handleClose = () => {
        store.getState().focusSuggestion(null)
    }

    if (!isOpen || !focused) return null

    return (
        <Sheet isOpen={isOpen} onClose={handleClose} title="Suggestion">
            <Sheet.Body contentClassName="px-4 pb-4 gap-2">
                <SuggestionThread
                    suggestion={focused}
                    driveItemId={driveItemId}
                    authorUserId={authorUserId}
                    canResolve={canResolve}
                    onAccept={() => onAccept(focused.id)}
                    onReject={() => onReject(focused.id)}
                />
            </Sheet.Body>
        </Sheet>
    )
}
