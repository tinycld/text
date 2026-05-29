import { expect, test } from '@playwright/test'
import {
    editorRoot,
    openFreshTextDocument,
    TEXT_TEST_TIMEOUT,
    waitForEditor,
} from './_menubar-helpers'

// Regression pin for the suggestion-popover dedup fix.
//
// Background: when a user types in Suggesting mode, each keystroke
// emits its own Yjs item. The decoration plugin in turn emits one
// inline Decoration per item range (because Yjs item boundaries fall
// between PM positions and DecorationSet.find returns one Decoration
// per overlapping range). Without dedupe, clicking on the resulting
// strikethrough/insertion text would render one popover row per Yjs
// item — a 40-char run of typed text would surface as 40 popover
// rows, each pointing at the same logical suggestion.
//
// lib/suggestions/popover.ts dedupes by (suggestionId, kind) before
// posting the show-popover payload. This spec types a multi-character
// run inside Suggesting mode, clicks on the resulting decoration,
// and asserts the popover contains exactly ONE row.
//
// It also pins the read-only contract: the popover surfaces a
// summary, not actionable buttons. Accept / Reject moved to the
// review drawer because acting from an inline popover forces
// per-suggestion resolve without doc-level context, which is the
// wrong default for non-trivial docs.

test.describe('Text — Suggestion popover dedup', () => {
    test.setTimeout(TEXT_TEST_TIMEOUT)

    test('long typed run → click → exactly ONE row, no accept buttons', async ({ page }) => {
        await openFreshTextDocument(page, 'popover-dedup')
        await editorRoot(page).click()
        await waitForEditor(page)

        // Enter Suggesting mode via the toolbar dropdown.
        await page.getByRole('button', { name: 'Editor mode' }).click()
        await page.getByRole('menuitem', { name: 'Suggesting' }).click()
        await expect(page.getByLabel('Suggesting mode')).toBeVisible({ timeout: 10_000 })

        // Re-focus the editor (menu interaction can shift focus), drop
        // the caret at end of doc + new paragraph, then type a long
        // phrase character-by-character so each keystroke creates a
        // separate Yjs item — the exact condition the dedup fix
        // targets.
        await editorRoot(page).click()
        const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
        await page.keyboard.press(`${meta}+End`)
        await page.keyboard.press('Enter')
        const phrase = `this is a long phrase that spans many items ${Date.now()}`
        await page.keyboard.type(phrase, { delay: 25 })

        // Wait for the suggestedInsert decoration to land. The schema's
        // renderHTML emits data-suggested-insert on every text node
        // carrying the mark; with a long run + per-character Yjs items,
        // multiple sibling spans appear.
        await expect(page.locator('[data-suggested-insert]').first()).toBeVisible({
            timeout: 10_000,
        })

        // Click on the suggested-insert text to open the popover. The
        // ProseMirror click handler in lib/suggestions/popover.ts
        // detects the click landed on a suggestion decoration, dedupes
        // by (suggestionId, kind), and posts a show-popover message;
        // the host's SuggestionOverlay mounts <SuggestionPopover />.
        await page.locator('[data-suggested-insert]').first().click()

        // The popover root carries accessibilityLabel="Suggestion details".
        const popover = page.getByLabel('Suggestion details')
        await expect(popover).toBeVisible({ timeout: 5_000 })

        // Critical assertion: exactly ONE row inside the popover, even
        // though the underlying Yjs items span many positions. Without
        // the dedup, this would surface as one row per item — easily
        // 40+ for a phrase of this length.
        const rows = popover.locator('[data-testid="suggestion-popover-row"]')
        await expect(rows).toHaveCount(1, { timeout: 5_000 })

        // The popover is read-only: Accept / Reject moved to the
        // review drawer. Assert neither button is present inside the
        // popover scope.
        await expect(popover.getByRole('button', { name: /^Accept/ })).toHaveCount(0)
        await expect(popover.getByRole('button', { name: /^Reject/ })).toHaveCount(0)
    })
})
