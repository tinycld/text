import { expect, test } from '@playwright/test'
import {
    editorRoot,
    openFreshTextDocument,
    TEXT_TEST_TIMEOUT,
    waitForEditor,
} from './_menubar-helpers'

// Auto-cleanup of orphaned suggestion entries. A Y.Map row in the
// `suggestions` map that has no doc anchor (Accept / Reject stripped
// the mark, a peer destructively edited the marked text, a past
// version wrote a row without a mark) is unactionable.
// useDocumentSuggestions detects those rows and deletes them inside a
// single Yjs transaction on the next observed editor transaction.
//
// This spec exercises the loop end-to-end:
//   1. Type a phrase in Suggesting mode → suggestionId row in the map
//      anchored by a suggestedInsert mark.
//   2. Switch to Editing mode (the resolver's mark-strip would be
//      re-intercepted by the command layer otherwise — same gotcha
//      the format-change and block-change specs work around).
//   3. Accept the suggestion → mark gone from the doc, row's status
//      flips to 'accepted'; the auto-cleanup pass observes the
//      next transaction and deletes the row.
//   4. Assert the suggestions Y.Map is empty AND the drawer renders
//      the empty-state copy, NOT an Orphaned section.

test.describe('Text — Orphan auto-delete', () => {
    test.setTimeout(TEXT_TEST_TIMEOUT)

    test('resolved suggestions self-clean from the suggestions Y.Map', async ({ page }) => {
        await openFreshTextDocument(page, 'orphan-auto-delete')
        await editorRoot(page).click()
        await waitForEditor(page)

        const meta = process.platform === 'darwin' ? 'Meta' : 'Control'

        // Switch to Suggesting mode. The mode-chip confirms the
        // command layer has accepted the mode + identity is set.
        await page.getByRole('button', { name: 'Editor mode' }).click()
        await page.getByRole('menuitem', { name: 'Suggesting' }).click()
        await expect(page.getByLabel('Suggesting mode')).toBeVisible({ timeout: 10_000 })

        // Re-focus the editor (menu click shifts focus) and drop the
        // caret at the very end of the doc so the new content doesn't
        // collide with the fixture heading.
        await editorRoot(page).click()
        await page.keyboard.press(`${meta}+End`)
        await page.keyboard.press('Enter')

        // Type a marker phrase. In Suggesting mode this lands with a
        // suggestedInsert mark.
        const marker = `orphan-test-${Date.now()}`
        await page.keyboard.type(marker, { delay: 15 })
        await expect(page.locator('[data-suggested-insert]').first()).toBeVisible({
            timeout: 5_000,
        })

        // The suggestions Y.Map now has exactly one entry (the session
        // is fresh, no prior suggestions). Read via the dev hook.
        await expect
            .poll(
                async () =>
                    page.evaluate(() => {
                        const w = window as unknown as {
                            __tinyTextDoc?: { getMap: (n: string) => { size: number } }
                        }
                        return w.__tinyTextDoc?.getMap('suggestions').size ?? -1
                    }),
                { timeout: 5_000 }
            )
            .toBe(1)

        // Switch to Editing mode so the resolver's mark-strip is NOT
        // re-intercepted as a fresh suggestion (the format-change and
        // block-change e2e specs document the same discipline).
        await page.getByRole('button', { name: 'Editor mode' }).click()
        await page.getByRole('menuitem', { name: 'Editing' }).click()
        await expect(page.getByLabel('Suggesting mode')).not.toBeVisible({ timeout: 5_000 })

        // Open the drawer and accept the suggestion.
        await page.getByRole('button', { name: 'Open suggestion review drawer' }).click()
        await page.getByRole('button', { name: 'Accept suggestion' }).first().click()

        // The mark is gone AND the Y.Map row has been cleaned up.
        // Polling absorbs the gap between the Accept's mark-strip and
        // the auto-delete's follow-up transaction.
        await expect
            .poll(
                async () =>
                    page.evaluate(() => {
                        const w = window as unknown as {
                            __tinyTextDoc?: { getMap: (n: string) => { size: number } }
                        }
                        return w.__tinyTextDoc?.getMap('suggestions').size ?? -1
                    }),
                { timeout: 10_000 }
            )
            .toBe(0)

        // The drawer shows the empty-state message and NO Orphaned
        // section (the regression this spec pins).
        await expect(page.getByText('No suggestions in this document.')).toBeVisible()
        await expect(page.getByText(/orphaned/i)).toHaveCount(0)
    })
})
