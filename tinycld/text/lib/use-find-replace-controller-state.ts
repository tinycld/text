import { useSyncExternalStore } from 'react'
import { Platform } from 'react-native'
import {
    FIND_REPLACE_EMPTY_STATE,
    type FindReplaceController,
    type FindReplaceControllerState,
} from './find-replace-controller'
import { useFindReplaceStateStore } from './stores/find-replace-state-store'

// Bar-side hook that returns the current controller state. On native
// it subscribes to the mirrored Zustand store so the bar re-renders
// when the WebView broadcasts a state-update; on web it reads the
// controller's getState() directly on every render (Tiptap's per-
// transaction re-render already brings us back here, so an explicit
// subscription would just duplicate work). Returns null when the
// controller isn't ready yet (web before tiptap mounts, native before
// the WebView has posted its initial broadcast).
//
// Implemented with useSyncExternalStore so the contract reads
// uniformly on both platforms; the web subscribe is a no-op returning
// a no-op unsubscribe.
//
// Lives in its own file (not alongside the controller factories) so
// the controller module stays free of react-native imports — that
// lets unit tests for the web controller load it without transforming
// react-native's Flow-syntax entry point.
export function useFindReplaceControllerState(
    controller: FindReplaceController | null
): FindReplaceControllerState | null {
    const isNative = Platform.OS !== 'web'
    const subscribe = isNative ? useFindReplaceStateStore.subscribe : noopSubscribe
    const getSnapshot = isNative
        ? getNativeStoreSnapshot
        : () => (controller ? controller.getState() : FIND_REPLACE_EMPTY_STATE)
    const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    if (!controller) return null
    return state
}

function noopSubscribe(): () => void {
    return () => undefined
}

function getNativeStoreSnapshot(): FindReplaceControllerState {
    const s = useFindReplaceStateStore.getState()
    return { matchCount: s.matchCount, currentIndex: s.currentIndex, query: s.query }
}
