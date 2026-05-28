import { describe, expect, it } from 'vitest'
import { createReviewDrawerStore } from '~/tinycld/text/stores/review-drawer-store'

describe('review-drawer-store', () => {
    it('defaults to closed with no document and no focused suggestion', () => {
        const store = createReviewDrawerStore()
        const s = store.getState()
        expect(s.isOpen).toBe(false)
        expect(s.driveItemId).toBeNull()
        expect(s.focusedSuggestionId).toBeNull()
    })

    it('open(driveItemId) opens for that document', () => {
        const store = createReviewDrawerStore()
        store.getState().open('di_abc')
        expect(store.getState().isOpen).toBe(true)
        expect(store.getState().driveItemId).toBe('di_abc')
    })

    it('close() clears open + focused suggestion, preserves driveItemId nulled', () => {
        const store = createReviewDrawerStore()
        store.getState().open('di_abc')
        store.getState().focusSuggestion('s_1')
        store.getState().close()
        expect(store.getState().isOpen).toBe(false)
        expect(store.getState().focusedSuggestionId).toBeNull()
    })

    it('focusSuggestion sets the focused id; null clears it', () => {
        const store = createReviewDrawerStore()
        store.getState().focusSuggestion('s_1')
        expect(store.getState().focusedSuggestionId).toBe('s_1')
        store.getState().focusSuggestion(null)
        expect(store.getState().focusedSuggestionId).toBeNull()
    })

    it('opening for a different document clears focused suggestion', () => {
        const store = createReviewDrawerStore()
        store.getState().open('di_a')
        store.getState().focusSuggestion('s_1')
        store.getState().open('di_b')
        expect(store.getState().driveItemId).toBe('di_b')
        expect(store.getState().focusedSuggestionId).toBeNull()
    })

    it('subscribers fire on isOpen changes', () => {
        const store = createReviewDrawerStore()
        let observed = false
        const unsub = store.subscribe(s => {
            observed = s.isOpen
        })
        store.getState().open('di_x')
        expect(observed).toBe(true)
        unsub()
    })
})
