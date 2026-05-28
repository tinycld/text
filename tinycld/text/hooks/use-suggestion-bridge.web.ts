import type { Editor } from '@tiptap/react'
import { useMemo } from 'react'
import type * as Y from 'yjs'
import { SuggestionsMap } from '../lib/suggestions/suggestions-map'
import { computeDocumentSuggestions } from './use-document-suggestions'
import type {
    DocumentSuggestionBridge,
    SuggestionBridgeOptions,
} from './use-suggestion-bridge.d'

// createWebSuggestionBridge produces a bridge backed directly by the
// host's editor. Pure-function helper for tests; the hook below
// wraps it with React lifecycle.
//
// When editor or yDoc is null (defensive — the React hook returns
// null in that case so this shouldn't be hit in practice), returns a
// no-op bridge that yields an empty snapshot and a stub unsubscribe.
export function createWebSuggestionBridge(
    options: SuggestionBridgeOptions
): DocumentSuggestionBridge {
    const { editor, yDoc } = options
    if (!editor || !yDoc) {
        return {
            getSnapshot: () => ({ anchored: [], orphaned: [] }),
            subscribe: () => () => {},
        }
    }
    const map = new SuggestionsMap(yDoc)
    return {
        getSnapshot: () => computeDocumentSuggestions(editor.state.doc, map),
        subscribe: (handler) => {
            editor.on('transaction', handler)
            const unobserve = map.observe(handler)
            return () => {
                editor.off('transaction', handler)
                unobserve()
            }
        },
    }
}

// useDocumentSuggestionBridge is the React entry point. Wraps
// createWebSuggestionBridge with useMemo so the bridge identity is
// stable while inputs are stable, and returns null when prerequisites
// are missing so consumers can gate their useSyncExternalStore
// subscription on a real bridge.
export function useDocumentSuggestionBridge(
    options: SuggestionBridgeOptions
): DocumentSuggestionBridge | null {
    const bridge = useMemo(
        () => createWebSuggestionBridge(options),
        [options.editor, options.yDoc, options.driveItemId]
    )
    if (!options.editor || !options.yDoc) return null
    return bridge
}
