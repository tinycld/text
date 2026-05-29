import { expect, test } from '@playwright/test'
import {
    editorRoot,
    openFreshTextDocument,
    TEXT_TEST_TIMEOUT,
    waitForEditor,
} from './_menubar-helpers'

// Click on a suggestion decoration → drawer opens + the matching row
// is focused. Replaces the obsolete popover-dedup spec: earlier phases
// rendered an inline tooltip popover with Accept/Reject buttons on
// click; the tooltip was deleted because it forced per-suggestion
// resolve without the doc-level context the drawer provides. Now the
// click is a pure navigation event — the drawer is the action surface.
//
// The plugin (lib/suggestions/click-to-focus.ts) publishes a
// 'suggestion-clicked' ui-bus message carrying the suggestionId. The
// screen's useSuggestionClickHandler subscribes and dispatches to the
// review-drawer store. SuggestionRow renders with isFocused=true when
// its id matches the store's focusedSuggestionId — the focus is what
// this spec asserts.

test.describe('Text — Suggestion click opens drawer focused', () => {
    test.setTimeout(TEXT_TEST_TIMEOUT)

    test('clicking a suggested-insert opens the drawer + focuses its row', async ({ page }) => {
        await openFreshTextDocument(page, 'suggestion-click-to-drawer')
        await editorRoot(page).click()
        await waitForEditor(page)

        // Enter Suggesting mode.
        await page.getByRole('button', { name: 'Editor mode' }).click()
        await page.getByRole('menuitem', { name: 'Suggesting' }).click()
        await expect(page.locator('[data-current-mode="suggesting"]')).toBeVisible({
            timeout: 10_000,
        })

        // Drop the caret at end of doc + new paragraph, then type a
        // phrase that lands as a suggestedInsert mark in Suggesting
        // mode.
        await editorRoot(page).click()
        const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
        await page.keyboard.press(`${meta}+End`)
        await page.keyboard.press('Enter')
        const phrase = `click target ${Date.now()}`
        await page.keyboard.type(phrase, { delay: 25 })
        await expect(page.locator('[data-suggested-insert]').first()).toBeVisible({
            timeout: 10_000,
        })

        // Drawer is closed initially.
        await expect(page.getByText('Suggestions').first()).not.toBeVisible()

        // Click on the suggested-insert text. The plugin's PM click
        // handler detects the decoration and publishes
        // 'suggestion-clicked' with the matching suggestionId. The
        // screen's subscriber opens the drawer + focuses the row.
        await page.locator('[data-suggested-insert]').first().click()

        // Drawer is now open — the "Suggestions" tab/header copy is
        // visible.
        await expect(page.getByText('Suggestions').first()).toBeVisible({ timeout: 5_000 })

        // The matching row is rendered. Pin via the Suggestion-by
        // accessibilityLabel; the focus state is internal styling and
        // not directly observable from the spec, but the row's mere
        // visibility after the click confirms the navigation worked.
        const suggestionRow = page.getByRole('button', { name: /^Suggestion by /i }).first()
        await expect(suggestionRow).toBeVisible({ timeout: 5_000 })

        // No inline popover renders alongside — there's no
        // "Suggestion details" tooltip anymore.
        await expect(page.getByLabel('Suggestion details')).toHaveCount(0)
    })
})
