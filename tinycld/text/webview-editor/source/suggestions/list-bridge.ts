import type { Editor } from '@tiptap/core'
import type * as Y from 'yjs'
import { computeDocumentSuggestions } from '../../../hooks/use-document-suggestions'
import { SuggestionsMap } from '../../../lib/suggestions/suggestions-map'

// computeSuggestionsForBridge walks the editor's doc + the Y.Map and
// returns the DocumentSuggestionsResult shape. Identical to Phase 2b's
// data layer; extracted here so the WebView's message handler can
// call it without pulling in the React hook. Returns only the public
// surface (anchored / orphaned) — the orphan-cleanup is a side-effect
// of installSuggestionListBridge, not of this pure helper.
export function computeSuggestionsForBridge(editor: Editor, yDoc: Y.Doc) {
    const map = new SuggestionsMap(yDoc)
    const compute = computeDocumentSuggestions(editor.state.doc, map)
    return { anchored: compute.anchored, orphaned: compute.orphaned }
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
    const map = new SuggestionsMap(yDoc)
    // hasSettled flips true on the first observed editor transaction.
    // Until then we skip the orphan-cleanup pass — Yjs sync is async
    // and a freshly-bootstrapped editor may not have the marks loaded
    // yet, so a naive cleanup would delete legitimate open suggestions.
    let hasSettled = false
    // Compute + push current snapshot to the host. Triggers the
    // orphan-cleanup pass (deleting Y.Map rows with no doc anchor)
    // when the parser flags them — same logic the web bridge uses,
    // mirrored here so the native path (snapshots pushed FROM the
    // WebView to the host's NativeSuggestionBridge) gets cleanup too.
    const pushSnapshot = () => {
        const compute = computeDocumentSuggestions(editor.state.doc, map)
        const result = { anchored: compute.anchored, orphaned: compute.orphaned }
        post('suggestion.changed', { driveItemId, result })
        if (hasSettled && compute.orphanedIds.length > 0) {
            map.deleteMany(compute.orphanedIds, yDoc)
        }
    }

    // Initial push so the host's bridge has data immediately on
    // mount; the host's getSnapshot returns this until subscriptions
    // produce updated data.
    pushSnapshot()

    // Subscribe to editor transactions (PM doc changes) and Y.Map
    // observer (other peers' changes to the suggestions map).
    const onTr = () => {
        hasSettled = true
        pushSnapshot()
    }
    editor.on('transaction', onTr)
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
