import { describe, expect, it } from 'vitest'
import { parseEditEvent } from '~/tinycld/text/hooks/parse-edit-events'

describe('parseEditEvent', () => {
    it('parses a valid event', () => {
        const raw = {
            clientId: 42,
            authorId: 'uo-A',
            startedAt: 1000,
            endedAt: 2000,
            editCount: 3,
            affectedNodes: [{ nodeId: 'p1', snippet: 'hello' }],
        }
        const parsed = parseEditEvent(raw)
        expect(parsed).not.toBeNull()
        expect(parsed!.clientId).toBe(42)
        expect(parsed!.editCount).toBe(3)
        expect(parsed!.affectedNodes).toHaveLength(1)
    })

    it('returns null on missing fields', () => {
        expect(parseEditEvent({ clientId: 42 })).toBeNull()
        expect(parseEditEvent(null)).toBeNull()
        expect(parseEditEvent('not an object')).toBeNull()
    })

    it('coerces affectedNodes default to empty array', () => {
        const raw = {
            clientId: 42,
            authorId: 'uo-A',
            startedAt: 1000,
            endedAt: 2000,
            editCount: 1,
        }
        const parsed = parseEditEvent(raw)
        expect(parsed).not.toBeNull()
        expect(parsed!.affectedNodes).toEqual([])
    })
})
