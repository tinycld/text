// @vitest-environment happy-dom
//
// EditorModeMenu is a core Menu: its rows render through the overlay host
// (OverlayProvider) once the trigger is pressed, as real `role="menuitem"`
// elements on web. The tests below cover:
//   - the pure `getVisibleModes(canEdit, canSuggest)` helper that gates
//     dropdown rows by permission — the menu's user-visible item set is a
//     direct render of this list, so locking the helper's contract locks
//     the menu's contract
//   - the trigger surfaces the current store mode as visible text (proves
//     useStore subscription is wired and MODE_LABELS lookup is correct)
//   - opening the menu lists one row per visible mode, and choosing a row
//     writes the store and closes the menu
//
// The full in-editor flow (mode switch → decorations) is exercised by the
// Playwright suite, which boots the real editor.

import { cleanup, fireEvent, render as renderBare, screen } from '@testing-library/react'
import { OverlayProvider } from '@tinycld/core/ui/overlay'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import {
    EditorModeMenu,
    getVisibleModes,
    MODE_LABELS,
} from '~/tinycld/text/components/EditorModeMenu'
import {
    createEditorModeStore,
    EDITOR_MODE_EDITING,
    EDITOR_MODE_SUGGESTING,
    EDITOR_MODE_VIEWING,
} from '~/tinycld/text/stores/editor-mode-store'

// Every surface renders through the overlay host, which the app mounts once.
const render = (ui: ReactElement) => renderBare(<OverlayProvider>{ui}</OverlayProvider>)

const menuRows = () =>
    Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).map(row =>
        row.textContent?.trim()
    )

// The trigger is a Pressable, which the react-native stub renders as a host
// element carrying its accessibility props verbatim.
const trigger = () => {
    const node = document.querySelector<HTMLElement>('[accessibilitylabel="Editor mode"]')
    if (!node) throw new Error('no Editor mode trigger')
    return node
}

describe('getVisibleModes', () => {
    it('always includes Viewing, even when both flags are false', () => {
        expect(getVisibleModes(false, false)).toEqual([EDITOR_MODE_VIEWING])
    })

    it('omits Editing when canEdit=false', () => {
        const modes = getVisibleModes(false, true)
        expect(modes).not.toContain(EDITOR_MODE_EDITING)
        expect(modes).toContain(EDITOR_MODE_SUGGESTING)
        expect(modes).toContain(EDITOR_MODE_VIEWING)
    })

    it('omits Suggesting when canSuggest=false', () => {
        const modes = getVisibleModes(true, false)
        expect(modes).toContain(EDITOR_MODE_EDITING)
        expect(modes).not.toContain(EDITOR_MODE_SUGGESTING)
        expect(modes).toContain(EDITOR_MODE_VIEWING)
    })

    it('returns all three modes when both flags are true', () => {
        expect(getVisibleModes(true, true)).toEqual([
            EDITOR_MODE_EDITING,
            EDITOR_MODE_SUGGESTING,
            EDITOR_MODE_VIEWING,
        ])
    })

    it('orders Editing before Suggesting before Viewing', () => {
        // Order is user-facing — readers expect a consistent top-down
        // arrangement in the dropdown. Lock it.
        const modes = getVisibleModes(true, true)
        expect(modes.indexOf(EDITOR_MODE_EDITING)).toBeLessThan(
            modes.indexOf(EDITOR_MODE_SUGGESTING)
        )
        expect(modes.indexOf(EDITOR_MODE_SUGGESTING)).toBeLessThan(
            modes.indexOf(EDITOR_MODE_VIEWING)
        )
    })
})

describe('MODE_LABELS', () => {
    it('has a human-readable label for each editor mode', () => {
        expect(MODE_LABELS[EDITOR_MODE_EDITING]).toBe('Editing')
        expect(MODE_LABELS[EDITOR_MODE_SUGGESTING]).toBe('Suggesting')
        expect(MODE_LABELS[EDITOR_MODE_VIEWING]).toBe('Viewing')
    })
})

describe('EditorModeMenu render', () => {
    afterEach(cleanup)

    it('renders the current mode label on the trigger', () => {
        const modeStore = createEditorModeStore()
        modeStore.getState().setMode(EDITOR_MODE_EDITING)
        render(<EditorModeMenu modeStore={modeStore} canEdit canSuggest />)
        expect(screen.getByText('Editing')).toBeTruthy()
    })

    it('renders a viewing label when the store starts in viewing mode', () => {
        const modeStore = createEditorModeStore()
        modeStore.getState().setMode(EDITOR_MODE_VIEWING)
        render(<EditorModeMenu modeStore={modeStore} canEdit canSuggest />)
        expect(screen.getByText('Viewing')).toBeTruthy()
    })

    it('does not crash when both permission flags are false', () => {
        // Trigger should still render with Viewing as the label
        // (Viewing is always available).
        const modeStore = createEditorModeStore()
        modeStore.getState().setMode(EDITOR_MODE_VIEWING)
        expect(() =>
            render(<EditorModeMenu modeStore={modeStore} canEdit={false} canSuggest={false} />)
        ).not.toThrow()
    })

    it('opens to one row per visible mode, in order', () => {
        const modeStore = createEditorModeStore()
        modeStore.getState().setMode(EDITOR_MODE_SUGGESTING)
        render(<EditorModeMenu modeStore={modeStore} canEdit canSuggest />)
        expect(menuRows()).toEqual([])

        fireEvent.click(trigger())

        expect(menuRows()).toEqual(['Editing', 'Suggesting', 'Viewing'])
    })

    it('hides the gated rows and writes the store when a row is chosen', () => {
        const modeStore = createEditorModeStore()
        modeStore.getState().setMode(EDITOR_MODE_EDITING)
        render(<EditorModeMenu modeStore={modeStore} canEdit canSuggest={false} />)

        fireEvent.click(trigger())
        expect(menuRows()).toEqual(['Editing', 'Viewing'])

        fireEvent.click(screen.getByText('Viewing'))
        expect(modeStore.getState().mode).toBe(EDITOR_MODE_VIEWING)
        // Choosing a row closes the menu.
        expect(menuRows()).toEqual([])
    })
})
