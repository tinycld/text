import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSuggestionSession } from '~/tinycld/text/lib/suggestions/session-grouping'

describe('suggestion session grouping', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('mints a new suggestionId on first touch', () => {
        const session = createSuggestionSession('uo_alice')
        const id1 = session.touch()
        expect(id1).toMatch(/^[0-9A-Z]{26}$/) // ulid shape
    })

    it('reuses the same suggestionId across rapid touches', () => {
        const session = createSuggestionSession('uo_alice')
        const id1 = session.touch()
        vi.advanceTimersByTime(100)
        const id2 = session.touch()
        expect(id2).toBe(id1)
    })

    it('reuses the same suggestionId at 29.9s idle', () => {
        const session = createSuggestionSession('uo_alice')
        const id1 = session.touch()
        vi.advanceTimersByTime(29_900)
        const id2 = session.touch()
        expect(id2).toBe(id1)
    })

    it('mints a fresh suggestionId after 30s idle', () => {
        const session = createSuggestionSession('uo_alice')
        const id1 = session.touch()
        vi.advanceTimersByTime(30_001)
        const id2 = session.touch()
        expect(id2).not.toBe(id1)
    })

    it('mints a fresh suggestionId after reset()', () => {
        const session = createSuggestionSession('uo_alice')
        const id1 = session.touch()
        session.reset()
        const id2 = session.touch()
        expect(id2).not.toBe(id1)
    })

    it('current() returns null before first touch', () => {
        const session = createSuggestionSession('uo_alice')
        expect(session.current()).toBeNull()
    })

    it('current() returns the active id after touch', () => {
        const session = createSuggestionSession('uo_alice')
        const id1 = session.touch()
        expect(session.current()).toBe(id1)
    })

    it('current() returns null after reset()', () => {
        const session = createSuggestionSession('uo_alice')
        session.touch()
        session.reset()
        expect(session.current()).toBeNull()
    })

    it('current() returns null after 30s idle', () => {
        const session = createSuggestionSession('uo_alice')
        session.touch()
        vi.advanceTimersByTime(30_001)
        expect(session.current()).toBeNull()
    })
})
