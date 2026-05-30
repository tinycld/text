import { useState } from 'react'
import type { DocumentSuggestionsResult } from './use-document-suggestions'
import type { DocumentSuggestionBridge, SuggestionBridgeOptions } from './use-suggestion-bridge.d'

// Internal shape that adds the message-processing method. The hook
// returns the narrower DocumentSuggestionBridge (the consumer can't
// process raw messages — only the screen wiring does that).
export interface NativeSuggestionBridge extends DocumentSuggestionBridge {
    processIncomingMessage: (kind: string, payload: unknown) => void
}

const EMPTY_RESULT: DocumentSuggestionsResult = { anchored: [], orphaned: [] }

// createNativeSuggestionBridge produces a bridge backed by incoming
// WebView messages. The bridge stores the latest received snapshot
// keyed on driveItemId; messages for other documents are ignored.
//
// processIncomingMessage is exposed for tests AND for the actual
// WebView onMessage callback wiring (the screen plumbs it through).
export function createNativeSuggestionBridge(
    options: SuggestionBridgeOptions
): NativeSuggestionBridge {
    let snapshot: DocumentSuggestionsResult = EMPTY_RESULT
    const subscribers = new Set<() => void>()

    const processIncomingMessage = (kind: string, payload: unknown) => {
        if (kind !== 'suggestion.changed') return
        const typed = payload as {
            driveItemId?: string
            result?: DocumentSuggestionsResult
        }
        if (typed.driveItemId !== options.driveItemId) return
        if (!typed.result) return
        snapshot = typed.result
        for (const handler of subscribers) {
            handler()
        }
    }

    return {
        getSnapshot: () => snapshot,
        subscribe: handler => {
            subscribers.add(handler)
            return () => {
                subscribers.delete(handler)
            }
        },
        processIncomingMessage,
    }
}

// useDocumentSuggestionBridge is the React entry. Returns a stable
// bridge instance for the lifetime of the (driveItemId) identity.
// The screen wires processIncomingMessage to the WebView's onMessage
// handler.
export function useDocumentSuggestionBridge(
    options: SuggestionBridgeOptions
): DocumentSuggestionBridge | null {
    const [bridge] = useState(() => createNativeSuggestionBridge(options))
    if (options.disabled) return null
    if (!options.driveItemId) return null
    return bridge
}
