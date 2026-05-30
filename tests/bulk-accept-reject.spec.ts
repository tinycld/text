import { expect, type Page, test } from '@playwright/test'
import { editorRoot, openFreshTextDocument, waitForEditor } from './_menubar-helpers'

// End-to-end flow for the drawer's bulk-resolve affordances:
// after several suggestions land in the doc, the "Accept all" /
// "Reject all" buttons resolve every open suggestion in one shot.
//
// Generating 3+ separate suggestionIds in a single test would require
// either 35s+ gaps between edits (too slow) or the dev hook to mint
// custom sessions. The simpler path: each "Editing-mode → Suggesting-
// mode" cycle resets the session window, so toggling modes between
// edits buckets each typed run into its own suggestionId. We use the
// toolbar's mode dropdown to do the toggling.
//
// "Accept all" strips every open suggestion's wrapper marks while
// preserving the typed text (insertions become regular runs). "Reject
// all" reverts every open suggestion's content (insertions get
// removed, deletions get restored). Both flows are covered here on
// fresh docs so the assertions don't have to disambiguate one
// scenario's residue from the other.

test.describe('Text — Bulk accept / reject', () => {
    // The session window in command-layer is 30s — we need at least
    // two 31s waits between typed runs to mint three distinct
    // suggestionIds. Add headroom over the editor warmup + drawer
    // interactions; pin a generous per-test budget so neither flake
    // path is timeout-induced.
    test.setTimeout(240_000)

    test('three suggestions → Accept all → all marks gone, text remains', async ({ page }) => {
        await openFreshTextDocument(page, 'bulk-accept-reject-accept')
        await editorRoot(page).click()
        await waitForEditor(page)

        const markers = await makeThreeSuggestions(page, 'accept-marker')

        // Open the drawer.
        await page.getByRole('button', { name: 'Open suggestion review drawer' }).click()
        await expect(page.getByText('Suggestions').first()).toBeVisible({ timeout: 5_000 })

        // SuggestionRow accessibilityLabel is "Suggestion by <authorId>".
        // Expect at least 3 rows — mode cycles produce distinct
        // sessions so each typed marker has its own row.
        const rows = page.getByRole('button', { name: /^Suggestion by /i })
        await expect(rows).toHaveCount(3, { timeout: 10_000 })

        // Click Accept all. The resolver strips suggestedInsert marks
        // off every open row's range; underlying text survives.
        await page.getByRole('button', { name: 'Accept all suggestions' }).click()

        // Every suggestedInsert decoration is gone — assert via
        // toHaveCount(0) on the selector. The schema renders the mark
        // as data-suggested-insert, so absence of the attribute pins
        // that no Accept-all leftover lingers.
        await expect(page.locator('[data-suggested-insert]')).toHaveCount(0, { timeout: 10_000 })

        // The underlying text Alice typed survives — Accept never
        // removes content, it strips the suggestion wrapper.
        for (const marker of markers) {
            await expect(page.getByText(marker)).toBeVisible({ timeout: 5_000 })
        }
    })

    test('three suggestions → Reject all → no marks, no inserted text', async ({ page }) => {
        await openFreshTextDocument(page, 'bulk-accept-reject-reject')
        await editorRoot(page).click()
        await waitForEditor(page)

        const markers = await makeThreeSuggestions(page, 'reject-marker')

        // Switch back to Editing mode BEFORE opening the drawer. The
        // resolver's tr.delete step would otherwise be re-intercepted
        // by the command layer's appendTransaction (still gated on
        // Suggesting mode), and the rejected text would be re-stamped
        // as a fresh suggestion instead of vanishing. Same discipline
        // as format-change-flow / block-change-flow.
        await page.getByRole('button', { name: 'Editor mode' }).click()
        await page.getByRole('menuitem', { name: 'Editing' }).click()
        await expect(page.locator('[data-current-mode="editing"]')).toBeVisible({ timeout: 5_000 })

        // Open the drawer; expect 3 rows.
        await page.getByRole('button', { name: 'Open suggestion review drawer' }).click()
        await expect(page.getByText('Suggestions').first()).toBeVisible({ timeout: 5_000 })
        const rows = page.getByRole('button', { name: /^Suggestion by /i })
        await expect(rows).toHaveCount(3, { timeout: 10_000 })

        // Click Reject all. The resolver removes the inserted content
        // (insertions revert; the doc returns to its pre-suggestion
        // state for each row).
        await page.getByRole('button', { name: 'Reject all suggestions' }).click()

        // No marks remain.
        await expect(page.locator('[data-suggested-insert]')).toHaveCount(0, { timeout: 10_000 })

        // The reverted content is gone — the typed markers are no
        // longer in the doc. Use the dev hook to inspect doc text so
        // this is robust against any residual styling around the
        // removed range.
        const text = await page.evaluate(() => {
            const w = window as unknown as {
                __tinyTextEditor?: { state: { doc: { textContent: string } } }
            }
            return w.__tinyTextEditor?.state.doc.textContent ?? ''
        })
        for (const marker of markers) {
            expect(text).not.toContain(marker)
        }
    })
})

// makeThreeSuggestions types three distinct markers, waiting past the
// 30s session idle timeout (see session-grouping.ts IDLE_TIMEOUT_MS)
// between each typing run so the bridge mints a fresh suggestionId
// for each run. Returns the typed markers for the caller to assert on.
//
// Why not mode-cycle: the command layer's session lives on the plugin
// instance keyed by authorId, not the mode — switching to Editing
// mode and back doesn't reset it. The session only resets when
// Date.now() - lastTouch > IDLE_TIMEOUT_MS, so we wait it out
// directly. 31s buffer beyond the 30s window absorbs scheduler jitter
// in CI without flake.
async function makeThreeSuggestions(page: Page, prefix: string): Promise<string[]> {
    const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
    const markers: string[] = []

    // Enter Suggesting mode once. The session does NOT reset on mode
    // switch; we only need to switch once and then let the idle window
    // separate the typed runs.
    await page.getByRole('button', { name: 'Editor mode' }).click()
    await page.getByRole('menuitem', { name: 'Suggesting' }).click()
    await expect(page.locator('[data-current-mode="suggesting"]')).toBeVisible({ timeout: 10_000 })

    for (let i = 0; i < 3; i++) {
        // Drop caret at end of doc + new paragraph, then type a unique
        // marker. The command layer rewrites each insert step into
        // addMark('suggestedInsert') over the new content.
        await editorRoot(page).click()
        await page.keyboard.press(`${meta}+End`)
        await page.keyboard.press('Enter')
        const marker = `${prefix}-${i}-${Date.now()}`
        markers.push(marker)
        await page.keyboard.type(marker, { delay: 20 })

        // Wait for the mark to land before pausing — the suggestionId
        // is allocated at the moment the bridge first observes the
        // addMark step.
        await expect(page.locator('[data-suggested-insert]').last()).toBeVisible({
            timeout: 10_000,
        })

        // Idle past IDLE_TIMEOUT_MS between runs so the next typing
        // mints a fresh suggestionId. Skip on the last iteration
        // (no need to wait after the third batch).
        if (i < 2) {
            await page.waitForTimeout(31_000)
        }
    }

    return markers
}
