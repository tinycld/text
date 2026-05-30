// @vitest-environment happy-dom
//
// EditorModeMenu's interactive surface lives inside @tinycld/core/ui/menu's
// portaled Content, which in turn renders through @gluestack-ui's Overlay.
// That stack relies on layout measurement (getBoundingClientRect / measure
// in window) and a React portal — neither of which behaves identically under
// happy-dom + the react-native stub used by vitest, where <Pressable> /
// <View> / <Text> render as bare lowercase HTML tags with no role mapping.
//
// What we DO verify here:
//   - the pure `getVisibleModes(canEdit, canSuggest)` helper that gates
//     dropdown rows by permission — the menu's user-visible item set is a
//     direct render of this list, so locking the helper's contract locks
//     the menu's contract
//   - the trigger surfaces the current store mode as visible text (proves
//     useStore subscription is wired and MODE_LABELS lookup is correct)
//   - the component import path itself — catches typos in the public
//     API before Phase 2a's screen wiring hits them at runtime
//
// The full open-menu interaction is exercised by the higher-level e2e
// suite in tests/playwright (Phase 2a Task 11) which boots the real
// editor and uses chromium's actual DOM, role mapping, and portal
// hosting — happy-dom can't truthfully stand in for that.

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
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
})
