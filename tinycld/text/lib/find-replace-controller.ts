import {
    type FindReplaceEditor,
    clearFind,
    findNext,
    findPrev,
    findReplacePluginKey,
    replaceAll,
    replaceCurrent,
    setFindQuery,
} from './find-replace-plugin'

// FindReplaceController abstracts the bar's editor dependency. The bar
// no longer talks to ProseMirror's state + dispatch directly — instead
// it reads observable state through getState() and posts commands
// through the controller's methods. Two implementations exist:
//
//   - makeWebFindReplaceController wraps the in-process Tiptap editor.
//     getState() reads the plugin state synchronously; commands
//     dispatch transactions inline. The bar re-renders per transaction
//     via Tiptap's shouldRerenderOnTransaction, so the bar always sees
//     the latest getState().
//
//   - makeNativeFindReplaceController posts messages to the WebView
//     through useWebViewEditor.postMessage. getState() reads from a
//     Zustand store that mirrors the WebView's broadcasted
//     state-update messages. The bar subscribes to the store so it
//     re-renders when the WebView's plugin state changes.
//
// The bar consumes this through useFindReplaceControllerState
// (declared in this module's companion hook file — see use-find-
// replace-controller-state.ts) which papers over the platform
// difference.
//
// This file is platform-neutral on purpose: it must be importable from
// a vitest context where `react-native` would otherwise fail to
// transform. The platform-aware bar-side hook lives separately.

export interface FindReplaceControllerState {
    matchCount: number
    currentIndex: number
    query: string
}

// Frozen so the module-level constant can never accidentally drift —
// every code path that reads "no controller / no matches" sees the
// same canonical zero state and a stable reference. Mirrors the
// EMPTY_SNAPSHOT pattern in use-y-undo-manager.ts.
export const FIND_REPLACE_EMPTY_STATE: FindReplaceControllerState = Object.freeze({
    matchCount: 0,
    currentIndex: 0,
    query: '',
})

// Pure helper used by useFindReplaceControllerState's getSnapshot. The
// useSyncExternalStore contract requires getSnapshot to return the
// same reference when nothing has changed — otherwise React loops on
// dev mode warnings or runs excess re-renders in production. Both
// branches of the hook (web reads `controller.getState()`, native
// reads the mirror Zustand store) produce fresh objects per call, so
// both go through this cache.
//
// Pulled out here (not in the hook file) so unit tests can load it
// without dragging in `react-native`'s Flow-syntax entry point. Mirrors
// computeNextSnapshot in use-y-undo-manager.ts.
export function computeNextFindReplaceSnapshot(
    cached: FindReplaceControllerState,
    next: FindReplaceControllerState
): FindReplaceControllerState {
    if (
        cached.matchCount === next.matchCount &&
        cached.currentIndex === next.currentIndex &&
        cached.query === next.query
    ) {
        return cached
    }
    return next
}

export interface FindReplaceController {
    // Synchronous read of the latest observable state. The bar reads
    // this directly each render; subscription mechanics live in the
    // companion hook file.
    getState(): FindReplaceControllerState
    // Commands. All are sync from the caller's perspective; native
    // fires-and-forgets postMessage, web dispatches synchronously.
    setQuery(query: string): void
    clear(): void
    next(): void
    prev(): void
    replaceCurrent(replacement: string): void
    replaceAll(replacement: string): void
}

// Web controller — wraps the existing FindReplaceEditor (state +
// dispatch) handle returned by the web variant of useDocumentEditor.
export function makeWebFindReplaceController(
    editor: FindReplaceEditor
): FindReplaceController {
    return {
        getState: () => {
            const s = findReplacePluginKey.getState(editor.state)
            if (!s) return FIND_REPLACE_EMPTY_STATE
            return { matchCount: s.matches.length, currentIndex: s.currentIndex, query: s.query }
        },
        setQuery: q => setFindQuery(editor, q),
        clear: () => clearFind(editor),
        next: () => findNext(editor),
        prev: () => findPrev(editor),
        replaceCurrent: r => replaceCurrent(editor, r),
        replaceAll: r => replaceAll(editor, r),
    }
}
