import { expect, test } from '@playwright/test'
import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from '../../tinycld/tests/e2e/helpers'
import { editorRoot, uniqueDocName, uploadDocxAsDriveItem, waitForEditor } from './_menubar-helpers'
import { createSecondUser, loginAs, shareDriveItemWith } from './helpers/seed-multi-user'

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
//
// Audience-presence gate: the server-side stamper only buffers
// EditEvents when the room has at least one other connection besides
// the writer (see text/server/authorship_stamper.go::HasOtherWriter).
// A solo writer therefore produces no activity rows — by design, since
// the activity log exists to surface what collaborators are doing for
// other collaborators. The test must boot a second connection on the
// same doc so the writer's edits are recorded.

test.describe('Text — Activity tab', () => {
    test('edits → 1s idle → activity row appears (with audience present)', async ({ browser }) => {
        // Upload the doc + share with a second user up front, before
        // any browser context exists. shareDriveItemWith grants the
        // second user explicit access to the drive item so they can
        // join the realtime room without a share link.
        const itemId = await uploadDocxAsDriveItem(uniqueDocName('activity-tab'))
        const userB = await createSecondUser('activity-tab')
        await shareDriveItemWith(itemId, userB)

        const writerCtx = await browser.newContext()
        const audienceCtx = await browser.newContext()
        try {
            const writer = await writerCtx.newPage()
            const audience = await audienceCtx.newPage()

            // Writer signs in as the shared test user. Audience is the
            // second user — their presence in the room satisfies the
            // server's HasOtherWriter audience gate so EditEvents
            // produced by the writer get buffered + flushed.
            await loginAs(writer, TEST_USER_EMAIL, TEST_USER_PASSWORD)
            await writer.goto(`/text/${itemId}`)
            await waitForEditor(writer)

            await loginAs(audience, userB.email, userB.password)
            await audience.goto(`/text/${itemId}`)
            await waitForEditor(audience)

            // Open the drawer on the writer's page so the Activity
            // empty-state copy is pinned before any edits have landed.
            await writer.getByRole('button', { name: 'Open suggestion review drawer' }).click()
            await expect(writer.getByText('Suggestions').first()).toBeVisible()

            await writer.getByRole('tab', { name: 'Activity' }).click()
            await expect(writer.getByText(/No activity yet/i)).toBeVisible()

            // Re-focus the editor (tab click moved focus to the drawer)
            // and type a few characters. Each keystroke flows through
            // the broker → stamper → editEventBuffer.Note, which only
            // records when the audience-presence gate passes.
            await editorRoot(writer).click()
            const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
            await writer.keyboard.press(`${meta}+End`)
            await writer.keyboard.press('Enter')
            const marker = `activity-${Date.now()}`
            await writer.keyboard.type(marker, { delay: 25 })
            await expect(writer.getByText(marker).first()).toBeVisible()

            // Wait past the shortened window so the buffer's per-
            // clientID timer fires and writes an EditEvent into
            // editEvents Y.Array. 2.5s covers the 1000ms window +
            // scheduler/network/observer slack.
            await writer.waitForTimeout(2_500)

            await expect(writer.getByText(/made \d+ edits?/i).first()).toBeVisible()
        } finally {
            await writerCtx.close()
            await audienceCtx.close()
        }
    })
})
