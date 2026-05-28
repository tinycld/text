import { useMemo } from 'react'
import { SuggestionsMap } from '../lib/suggestions/suggestions-map'
import { computeDocumentSuggestions } from './use-document-suggestions'
import type { DocumentSuggestionBridge, SuggestionBridgeOptions } from './use-suggestion-bridge.d'

// EMPTY_RESULT is a stable identity returned by no-op bridges (null
// editor / null yDoc) so React's useSyncExternalStore doesn't see a
// fresh object reference each render and log the "result of
// getSnapshot should be cached to avoid an infinite loop" warning.
const EMPTY_RESULT = { anchored: [], orphaned: [] }

// createWebSuggestionBridge produces a bridge backed directly by the
// host's editor. Pure-function helper for tests; the hook below
// wraps it with React lifecycle.
//
// When editor or yDoc is null (defensive — the React hook returns
// null in that case so this shouldn't be hit in practice), returns a
// no-op bridge that yields an empty snapshot and a stub unsubscribe.
//
// The non-empty branch caches the most recently computed snapshot and
// recomputes only when the editor's transaction fires or the Y.Map's
// observe callback runs. useSyncExternalStore reads getSnapshot on
// every render and requires the reference to be stable across renders
// when nothing changed — without the cache, React dev mode logs the
// infinite-loop warning. Subscribers fire AFTER the cache is
// invalidated so getSnapshot returns the fresh snapshot on the
// subsequent React-driven read.
export function createWebSuggestionBridge(
    options: SuggestionBridgeOptions
): DocumentSuggestionBridge {
    const { editor, yDoc } = options
    if (!editor || !yDoc) {
        return {
            getSnapshot: () => EMPTY_RESULT,
            subscribe: () => () => {},
        }
    }
    const map = new SuggestionsMap(yDoc)
    let cached = computeDocumentSuggestions(editor.state.doc, map)
    let dirty = false
    const invalidate = () => {
        dirty = true
    }
    return {
        getSnapshot: () => {
            if (dirty) {
                cached = computeDocumentSuggestions(editor.state.doc, map)
                dirty = false
            }
            return cached
        },
        subscribe: handler => {
            const onChange = () => {
                invalidate()
                handler()
            }
            editor.on('transaction', onChange)
            const unobserve = map.observe(onChange)
            return () => {
                editor.off('transaction', onChange)
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
    const { editor, yDoc, driveItemId } = options
    const bridge = useMemo(
        () => createWebSuggestionBridge({ editor, yDoc, driveItemId }),
        [editor, yDoc, driveItemId]
    )
    if (!editor || !yDoc) return null
    return bridge
}
