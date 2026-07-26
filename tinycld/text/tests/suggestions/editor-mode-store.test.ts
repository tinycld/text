import { describe, expect, it } from 'vitest'
import {
    createEditorModeStore,
    EDITOR_MODE_EDITING,
    EDITOR_MODE_SUGGESTING,
    EDITOR_MODE_VIEWING,
} from '~/tinycld/text/stores/editor-mode-store'

describe('editor-mode-store', () => {
    it('defaults to editing mode', () => {
        const store = createEditorModeStore()
        expect(store.getState().mode).toBe(EDITOR_MODE_EDITING)
    })

    it('setMode updates the mode', () => {
        const store = createEditorModeStore()
        store.getState().setMode(EDITOR_MODE_SUGGESTING)
        expect(store.getState().mode).toBe(EDITOR_MODE_SUGGESTING)
    })

    it('setMode to viewing is allowed even without identity', () => {
        const store = createEditorModeStore()
        store.getState().setMode(EDITOR_MODE_VIEWING)
        expect(store.getState().mode).toBe(EDITOR_MODE_VIEWING)
    })

    it('setIdentity stores the user-org id', () => {
        const store = createEditorModeStore()
        store.getState().setIdentity({ userId: 'uo_abc123' })
        expect(store.getState().identity?.userId).toBe('uo_abc123')
    })

    it('setIdentity with null clears identity', () => {
        const store = createEditorModeStore()
        store.getState().setIdentity({ userId: 'uo_abc123' })
        store.getState().setIdentity(null)
        expect(store.getState().identity).toBeNull()
    })

    it('subscribes to mode changes', () => {
        const store = createEditorModeStore()
        let observed: string | null = null
        const unsubscribe = store.subscribe(s => {
            observed = s.mode
        })
        store.getState().setMode(EDITOR_MODE_SUGGESTING)
        expect(observed).toBe(EDITOR_MODE_SUGGESTING)
        unsubscribe()
    })
})
