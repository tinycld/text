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

export const FIND_REPLACE_EMPTY_STATE: FindReplaceControllerState = {
    matchCount: 0,
    currentIndex: 0,
    query: '',
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
