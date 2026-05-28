import type { Editor } from '@tiptap/core'
import type * as Y from 'yjs'
import { computeDocumentSuggestions } from '../../../hooks/use-document-suggestions'
import { SuggestionsMap } from '../../../lib/suggestions/suggestions-map'

// computeSuggestionsForBridge walks the editor's doc + the Y.Map and
// returns the DocumentSuggestionsResult shape. Identical to Phase 2b's
// data layer; extracted here so the WebView's message handler can
// call it without pulling in the React hook.
export function computeSuggestionsForBridge(editor: Editor, yDoc: Y.Doc) {
    const map = new SuggestionsMap(yDoc)
    return computeDocumentSuggestions(editor.state.doc, map)
}

// Wire shape:
//
// Host -> WebView "suggestion.list"
//   Payload: { driveItemId: string }
//   Response: "suggestion.list-reply" (effectively the same as
//             suggestion.changed — push the current snapshot)
// WebView -> Host push: "suggestion.changed"
//   Payload: { driveItemId, result: DocumentSuggestionsResult }
//
// installSuggestionListBridge wires both the request/response handler
// and the change-pusher. Call once per WebView Editor instance after
// mounting; the returned cleanup tears down both subscriptions.
export function installSuggestionListBridge(
    editor: Editor,
    yDoc: Y.Doc,
    driveItemId: string,
    post: (kind: string, payload: unknown) => void
): () => void {
    // Push the current snapshot to the host
    const pushSnapshot = () => {
        const result = computeSuggestionsForBridge(editor, yDoc)
        post('suggestion.changed', { driveItemId, result })
    }

    // Initial push so the host's bridge has data immediately on
    // mount; the host's getSnapshot returns this until subscriptions
    // produce updated data.
    pushSnapshot()

    // Subscribe to editor transactions (PM doc changes) and Y.Map
    // observer (other peers' changes to the suggestions map).
    const onTr = () => pushSnapshot()
    editor.on('transaction', onTr)
    const map = new SuggestionsMap(yDoc)
    const unobserve = map.observe(pushSnapshot)

    // Listen for explicit host-side list requests (rare; mostly used
    // for resync on app foreground or hot reload).
    const messageListener = (event: MessageEvent) => {
        try {
            const data = typeof event.data === 'string' ? event.data : ''
            const msg = JSON.parse(data) as {
                kind?: string
                payload?: { driveItemId?: string }
            }
            if (msg.kind === 'suggestion.list' && msg.payload?.driveItemId === driveItemId) {
                pushSnapshot()
            }
        } catch {
            // Not our message
        }
    }
    window.addEventListener('message', messageListener)

    return () => {
        editor.off('transaction', onTr)
        unobserve()
        window.removeEventListener('message', messageListener)
    }
}
