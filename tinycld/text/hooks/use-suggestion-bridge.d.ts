import type { Editor } from '@tiptap/react'
import type * as Y from 'yjs'
import type { DocumentSuggestionsResult } from './use-document-suggestions'

// SuggestionBridgeOptions: per-mount inputs the bridge needs.
//
// driveItemId is always required (used to filter incoming messages on
// native; identifies the document scope on both platforms).
//
// yDoc is the Yjs document; present on web (host owns it) and on
// native (host has it from the realtime room). The Y.Map-only path
// (orphaned entries) works on both platforms.
//
// editor is the host-side TipTap editor. Non-null on web (the host
// runs TipTap directly in the page); null on native (the WebView
// owns the canonical editor). The bridge implementation branches on
// editor nullness to pick its data path.
export interface SuggestionBridgeOptions {
    driveItemId: string
    yDoc: Y.Doc | null
    editor: Editor | null
    // When true, the bridge short-circuits to null without subscribing
    // to the editor or Y.Map. Used by read-only viewer mounts where
    // suggestions are not exposed by design (see screens/[id].tsx
    // for the read-only design decision).
    disabled?: boolean
}

// DocumentSuggestionBridge surfaces the same DocumentSuggestionsResult
// shape the Phase 2b data hook produced, but abstracts over where
// the anchor data comes from. Web reads the host's editor and Y.Map
// directly; native subscribes to WebView-pushed snapshots.
//
// The interface is shaped as "subscribe-and-get-snapshot" rather than
// "fetch":
//   - getSnapshot() returns the current result synchronously
//   - subscribe(handler) returns an unsubscribe; handler fires when
//     the snapshot changes (either editor transaction OR Y.Map
//     observer on web; incoming WebView message on native)
//
// React consumers wrap this with useSyncExternalStore to get the
// reactive behavior.
export interface DocumentSuggestionBridge {
    getSnapshot: () => DocumentSuggestionsResult
    subscribe: (handler: () => void) => () => void
}

// useDocumentSuggestionBridge returns the bridge instance. Returns
// null until the bridge is ready: yDoc present; on web, additionally
// requires the editor.
export function useDocumentSuggestionBridge(
    options: SuggestionBridgeOptions
): DocumentSuggestionBridge | null
