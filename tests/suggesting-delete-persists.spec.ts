import { expect, test } from '@playwright/test'
import { editorRoot, openFreshTextDocument, waitForEditor } from './_menubar-helpers'

// Regression: deletes performed in Suggesting mode must survive a page
// reload as strikethrough proposals, not as silent hard deletions.
//
// User-facing bug:
//   1. switch to Suggesting mode
//   2. delete some text — it shows with strikethrough as a proposal
//   3. reload the page — the strikethrough is gone AND the underlying
//      text is gone too. The deletion silently committed as if the user
//      had been in Editing mode the whole time.
//
// Contract this test pins:
//   - After a delete-in-suggesting-mode, the doc surfaces a
//     `data-suggested-delete` span carrying the deleted run.
//   - After a page reload (which re-bootstraps the room from the
//     persisted .docx blob on the server), that same run is still
//     visible AND still bears the data-suggested-delete attribute.
//
// The reload is the load-bearing step: the bug is in the persistence
// round-trip, so an assertion that only fires inside the original
// session would pass even if the docx flush dropped the mark.

test.describe('Text — Suggesting-mode delete persists across reload', () => {
    test('delete in suggesting mode → reload → strikethrough proposal still there', async ({
        page,
    }) => {
        await openFreshTextDocument(page, 'suggesting-delete-persists')
        await editorRoot(page).click()
        await waitForEditor(page)

        // Append a deterministic marker line in Editing mode (the
        // default). The marker has to be ordinary plain text — i.e. a
        // hard-committed run — so the subsequent Suggesting-mode delete
        // has something to bite. Typing it before flipping to Suggesting
        // ensures the run hits the server as real content, NOT as a
        // suggestedInsert mark that the delete-in-suggesting flow would
        // treat as Case 2d (the author's own pending insert).
        const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
        await page.keyboard.press(`${meta}+End`)
        await page.keyboard.press('Enter')
        const marker = `delete-me-${Date.now()}`
        await page.keyboard.type(marker, { delay: 20 })
        await expect(page.getByText(marker)).toBeVisible()

        // Flip the editor into Suggesting mode via the toolbar dropdown.
        await page.getByRole('button', { name: 'Editor mode' }).click()
        await page.getByRole('menuitem', { name: 'Suggesting' }).click()
        await expect(page.locator('[data-current-mode="suggesting"]')).toBeVisible()

        // Re-focus the editor and select the marker run, then delete it.
        // The command layer rewrites the delete into:
        //   - a re-insertion of the deleted slice at the same offset
        //   - a suggestedDelete mark covering that slice
        // so the doc visually still shows the run, but struck through
        // with author-attribution + a drawer entry.
        // Triple-click selects the whole paragraph containing the
        // marker — robust across keymap variation (Shift+Home isn't a
        // standard PM keymap and varies by browser/platform).
        const markerLocator = page.getByText(marker)
        await markerLocator.click({ clickCount: 3 })
        await page.keyboard.press('Backspace')

        // suggestedDelete mark renders as a span with
        // data-suggested-delete (schema renderHTML). Its presence is the
        // signal the command layer actually rewrote the delete instead
        // of letting it commit as a hard removal.
        const struck = page.locator(`[data-suggested-delete]:has-text("${marker}")`)
        await expect(struck).toBeVisible()
        // And the underlying text is still on the page.
        await expect(page.getByText(marker)).toBeVisible()

        // The persistence step. The realtime SaveCoordinator debounces
        // and then flushes the Y.Doc through translate.PMJSONToDocx
        // back into the drive_items .docx blob; on next room open the
        // bootstrap re-parses that .docx and reseeds the Y.Doc. Give
        // the flush a window before reloading, otherwise we'd be
        // reading the previous flush's state.
        await page.waitForTimeout(3_000)

        await page.reload()
        await waitForEditor(page)

        // The deleted run survives: still in the doc, still marked as
        // a deletion proposal. The previous bug let the text vanish
        // entirely on reload — the assertion below would fail with
        // "locator resolved to 0 elements".
        await expect(page.locator(`[data-suggested-delete]:has-text("${marker}")`)).toBeVisible()
        await expect(page.getByText(marker)).toBeVisible()
    })
})
