import { describe, expect, it } from 'vitest'
import type {
    EditEvent,
    Suggestion,
    SuggestionStatus,
} from '~/tinycld/text/webview-editor/source/suggestions/suggestion-types'
import {
    SUGGESTION_DOC_SCHEMA_VERSION,
    SUGGESTION_STATUS_ACCEPTED,
    SUGGESTION_STATUS_OPEN,
    SUGGESTION_STATUS_REJECTED,
} from '~/tinycld/text/webview-editor/source/suggestions/suggestion-types'

describe('suggestion types', () => {
    it('exposes the doc schema version constant', () => {
        expect(SUGGESTION_DOC_SCHEMA_VERSION).toBe(1)
    })

    it('exposes the three suggestion status constants', () => {
        expect(SUGGESTION_STATUS_OPEN).toBe('open')
        expect(SUGGESTION_STATUS_ACCEPTED).toBe('accepted')
        expect(SUGGESTION_STATUS_REJECTED).toBe('rejected')
        const statuses: SuggestionStatus[] = [
            SUGGESTION_STATUS_OPEN,
            SUGGESTION_STATUS_ACCEPTED,
            SUGGESTION_STATUS_REJECTED,
        ]
        expect(statuses).toHaveLength(3)
    })

    it('Suggestion type accepts a minimal open suggestion', () => {
        const s: Suggestion = {
            id: '01HXYZ',
            authorId: 'user-org-id',
            createdAt: Date.now(),
            status: SUGGESTION_STATUS_OPEN,
        }
        expect(s.status).toBe('open')
    })

    it('Suggestion type accepts a resolved suggestion with note', () => {
        const s: Suggestion = {
            id: '01HXYZ',
            authorId: 'user-org-id',
            createdAt: Date.now() - 60000,
            status: SUGGESTION_STATUS_ACCEPTED,
            resolvedBy: 'editor-user-org-id',
            resolvedAt: Date.now(),
            note: 'rewrite intro',
        }
        expect(s.note).toBe('rewrite intro')
    })

    it('EditEvent type carries the expected shape', () => {
        const e: EditEvent = {
            clientId: 42,
            authorId: 'user-org-id',
            startedAt: 1,
            endedAt: 60001,
            editCount: 12,
            affectedNodes: [{ nodeId: 'p1', snippet: 'hello' }],
        }
        expect(e.editCount).toBe(12)
    })
})
