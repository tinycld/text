import { expect, test } from '@playwright/test'
import {
    editorRoot,
    openFreshTextDocument,
    TEXT_TEST_TIMEOUT,
    waitForEditor,
} from './_menubar-helpers'

// End-to-end flow for the review drawer's Activity tab. After the
// server's edit-event debounce window closes on a clientID, an entry
// lands in the doc's editEvents Y.Array; the drawer subscribes via
// useEditEvents and renders one row per entry.
//
// Production debounces 60s of inactivity per clientID. For e2e that's
// too slow to fit in one test budget, so the playwright.config.ts
// webServer env sets TINYCLD_EDIT_EVENT_WINDOW_MS=1000, which the
// Go side reads at boot in edit_event_buffer.go:configureWindowFromEnv
// and overrides WindowDuration to 1s. The spec then waits ~1.5s past
// the last keystroke to let the window close + the flush fan back out.
//
// The tab control uses accessibilityRole="tab" with accessibilityLabel
// matching the tab name (see ReviewDrawer.tsx::TabButton). We click
// the "Activity" tab once the drawer is open.

test.describe('Text — Activity tab', () => {
    test.setTimeout(TEXT_TEST_TIMEOUT)

    test('edits → 1s idle → activity row appears', async ({ page }) => {
        await openFreshTextDocument(page, 'activity-tab')
        await editorRoot(page).click()
        await waitForEditor(page)

        // Open the drawer FIRST so we can pin the Activity tab's
        // empty-state copy before any edits have landed.
        await page.getByRole('button', { name: 'Open suggestion review drawer' }).click()
        await expect(page.getByText('Suggestions').first()).toBeVisible({ timeout: 5_000 })

        // Switch to the Activity tab. The tab control is web-only and
        // mounts when yDoc is present, which it always is after the
        // realtime room finishes opening. The role + name pair
        // matches the TabButton implementation in ReviewDrawer.tsx.
        await page.getByRole('tab', { name: 'Activity' }).click()

        // Empty state: the user has made zero edits, so the tab shows
        // the explanatory copy from ActivityTab.tsx (verbatim except
        // for case-insensitive matching to absorb minor copy tweaks).
        await expect(page.getByText(/No activity yet/i)).toBeVisible({ timeout: 5_000 })

        // Re-focus the editor (the tab click shifts focus to the
        // drawer) and type a few characters. Each keystroke flows
        // through the broker → stamper → editEventBuffer.Note,
        // which extends the current window without flushing.
        await editorRoot(page).click()
        const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
        await page.keyboard.press(`${meta}+End`)
        await page.keyboard.press('Enter')
        const marker = `activity-${Date.now()}`
        await page.keyboard.type(marker, { delay: 25 })
        await expect(page.getByText(marker).first()).toBeVisible({ timeout: 10_000 })

        // Wait past the shortened window so the buffer's per-clientID
        // timer fires and writes an EditEvent into editEvents Y.Array.
        // The flush callback also broadcasts a delta; the client
        // observe handler on editEvents re-runs useEditEvents and the
        // ActivityTab re-renders.
        //
        // 2.5s = window (1000ms) + buffer for goroutine scheduling +
        // network broadcast + observer re-publish + React commit.
        await page.waitForTimeout(2_500)

        // The summarize() helper composes "<name> made N edit(s)"; we
        // match the "made N edits" suffix (case-insensitive) so name
        // resolution + pluralization don't tie the assertion to a
        // specific phrasing.
        await expect(page.getByText(/made \d+ edits?/i).first()).toBeVisible({
            timeout: 10_000,
        })
    })
})
