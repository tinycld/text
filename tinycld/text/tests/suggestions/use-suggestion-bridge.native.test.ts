// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import type { DocumentSuggestionsResult } from '~/tinycld/text/hooks/use-document-suggestions'
import { createNativeSuggestionBridge } from '~/tinycld/text/hooks/use-suggestion-bridge.native'

describe('native suggestion bridge', () => {
    it('getSnapshot returns empty result before any message arrives', () => {
        const bridge = createNativeSuggestionBridge({
            driveItemId: 'di_x',
            yDoc: null,
            editor: null,
        })
        expect(bridge.getSnapshot()).toEqual({ anchored: [], orphaned: [] })
    })

    it('processIncomingMessage updates snapshot for matching driveItemId', () => {
        const bridge = createNativeSuggestionBridge({
            driveItemId: 'di_x',
            yDoc: null,
            editor: null,
        })
        const result: DocumentSuggestionsResult = {
            anchored: [
                {
                    id: 's1',
                    status: 'open',
                    authorId: 'uo_a',
                    ts: 1,
                    kind: 'insert',
                    anchorRange: { from: 1, to: 5 },
                    snippet: 'foo',
                },
            ],
            orphaned: [],
        }
        bridge.processIncomingMessage('suggestion.changed', {
            driveItemId: 'di_x',
            result,
        })
        expect(bridge.getSnapshot().anchored).toHaveLength(1)
        expect(bridge.getSnapshot().anchored[0].id).toBe('s1')
    })

    it('processIncomingMessage ignores messages for a different driveItemId', () => {
        const bridge = createNativeSuggestionBridge({
            driveItemId: 'di_x',
            yDoc: null,
            editor: null,
        })
        const result: DocumentSuggestionsResult = {
            anchored: [
                {
                    id: 's_other',
                    status: 'open',
                    authorId: 'uo_a',
                    ts: 1,
                    kind: 'insert',
                    anchorRange: { from: 1, to: 5 },
                    snippet: 'foo',
                },
            ],
            orphaned: [],
        }
        bridge.processIncomingMessage('suggestion.changed', {
            driveItemId: 'di_OTHER',
            result,
        })
        expect(bridge.getSnapshot().anchored).toHaveLength(0)
    })

    it('subscribe handler fires when a message updates the snapshot', () => {
        const bridge = createNativeSuggestionBridge({
            driveItemId: 'di_x',
            yDoc: null,
            editor: null,
        })
        let fired = 0
        const unsub = bridge.subscribe(() => {
            fired++
        })
        const result: DocumentSuggestionsResult = {
            anchored: [],
            orphaned: [],
        }
        bridge.processIncomingMessage('suggestion.changed', {
            driveItemId: 'di_x',
            result,
        })
        expect(fired).toBe(1)
        unsub()
    })

    it('processIncomingMessage ignores messages of unrelated kinds', () => {
        const bridge = createNativeSuggestionBridge({
            driveItemId: 'di_x',
            yDoc: null,
            editor: null,
        })
        let fired = 0
        bridge.subscribe(() => {
            fired++
        })
        bridge.processIncomingMessage('something.else', { driveItemId: 'di_x' })
        expect(fired).toBe(0)
        expect(bridge.getSnapshot().anchored).toEqual([])
    })
})
