import { expect, test } from '@playwright/test'
import {
    editorRoot,
    openFreshTextDocument,
    TEXT_TEST_TIMEOUT,
    waitForEditor,
} from './_menubar-helpers'

// Single-user end-to-end flow for the Suggesting mode happy path:
// switch into Suggesting → type a phrase → it surfaces with an
// insertion decoration (suggestedInsert mark, NOT a real-text commit) →
// open the review drawer → row appears with the author label + Accept
// button → clicking Accept removes the mark while keeping the
// underlying text (the proposal becomes part of the document) and the
// drawer's empty-state copy lands.
//
// This pins the contract end users feel: typing in Suggesting mode
// never silently commits text as a hard edit, the drawer is the
// canonical place to act on proposals, and Accept actually applies
// the proposed mutation. Earlier phases covered each layer in unit
// tests; this is the first e2e that drives the full flow through the
// UI a real user touches.

test.describe('Text — Suggesting mode flow', () => {
    test.setTimeout(TEXT_TEST_TIMEOUT)

    test('type in suggesting mode → drawer row → accept', async ({ page }) => {
        await openFreshTextDocument(page, 'suggesting-mode-flow')
        await editorRoot(page).click()
        await waitForEditor(page)

        // Switch the editor into Suggesting mode via the toolbar
        // dropdown. The dropdown trigger uses accessibilityLabel
        // "Editor mode"; items render with role "menuitem" on web
        // (their ItemTitle text inferred as the accessible name).
        await page.getByRole('button', { name: 'Editor mode' }).click()
        await page.getByRole('menuitem', { name: 'Suggesting' }).click()

        // The EditorModeMenu trigger flips its accessibilityLabel to
        // "Suggesting mode" (and styles itself in the primary color
        // pill) when the current mode is not Editing — the signal that
        // the mode actually flipped on the store.
        await expect(page.locator('[data-current-mode="suggesting"]')).toBeVisible({
            timeout: 10_000,
        })

        // Re-focus the editor (the menu click can shift focus) and
        // drop the caret at the very end so the new content doesn't
        // collide with the fixture heading.
        await editorRoot(page).click()
        const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
        await page.keyboard.press(`${meta}+End`)
        await page.keyboard.press('Enter')

        // Type a marker phrase. In Suggesting mode the command layer
        // rewrites each insert step into addMark('suggestedInsert')
        // covering the new content — the text lands AND carries the
        // mark, so the doc renders the proposal inline with the
        // author-colored background tint + underline.
        const marker = `suggested insertion ${Date.now()}`
        await page.keyboard.type(marker, { delay: 30 })

        // The suggestedInsert mark renders as a span with
        // data-suggested-insert (schema renderHTML). When it lands the
        // suggestion has been stamped through the Yjs round-trip and
        // the editor has re-rendered.
        await expect(page.locator('[data-suggested-insert]').first()).toBeVisible({
            timeout: 10_000,
        })
        await expect(page.getByText(marker)).toBeVisible({ timeout: 5_000 })

        // Open the review drawer. The toolbar's drawer-toggle uses
        // accessibilityLabel "Open suggestion review drawer".
        await page.getByRole('button', { name: 'Open suggestion review drawer' }).click()

        // The drawer's Suggestions tab/header copy reads "Suggestions"
        // — visible regardless of whether we're on the extended-tabs
        // (web) or simple-header (native/no-yDoc) path.
        await expect(page.getByText('Suggestions').first()).toBeVisible({ timeout: 5_000 })

        // SuggestionRow carries accessibilityLabel="Suggestion by <authorId>".
        // First() is necessary because session-grouping can produce
        // multiple session ids if the test is slow enough between the
        // initial Enter keystroke and the typed marker; the drawer
        // renders Accept on every row and .first() is sufficient.
        const suggestionRow = page.getByRole('button', { name: /^Suggestion by /i }).first()
        await expect(suggestionRow).toBeVisible({ timeout: 10_000 })

        // Click Accept on the first row. The mutation strips the
        // suggestedInsert mark (the text remains in the doc as a
        // regular run) and marks the suggestions Y.Map entry as
        // accepted; the decoration plugin re-runs and the inline
        // styling disappears.
        await page.getByRole('button', { name: 'Accept suggestion' }).first().click()

        // The accepted text remains as a normal paragraph run — the
        // editor still shows the marker. We assert the underlying
        // text survives the accept (no silent data loss).
        await expect(page.getByText(marker)).toBeVisible({ timeout: 5_000 })

        // Once the row's mark is gone the decoration is dropped too —
        // no more data-suggested-insert spans for this suggestion. If
        // the test produced a single suggestion (the common case), the
        // drawer's empty-state lands; if more were produced the row
        // count drops by one. Either way the original row is now gone:
        // its Accept button no longer exists. Wait on that signal to
        // pin the accept actually completed.
        await expect(suggestionRow).not.toBeVisible({ timeout: 10_000 })
    })
})
