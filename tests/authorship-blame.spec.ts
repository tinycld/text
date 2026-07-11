import { expect, test } from '@playwright/test'
import { ORG_SLUG, TEST_USER_EMAIL, TEST_USER_PASSWORD } from '../../tinycld/tests/e2e/helpers'
import {
    editorRoot,
    FEATURE_DOC_HEADING,
    uniqueDocName,
    uploadDocxAsDriveItem,
    waitForEditor,
} from './_menubar-helpers'
import {
    createSecondUser,
    loginAs,
    readClientAuthors,
    shareDriveItemWith,
} from './helpers/seed-multi-user'

// End-to-end flow for paragraph-scoped authorship "blame":
// Alice + Bob each type into distinct paragraphs, the doc's
// clientAuthors Y.Map collects both clientIDs → user_org_ids, the
// Authorship tab surfaces per-contributor percentages, and a
// right-click on a paragraph opens a popover scoped to that
// paragraph's authors.
//
// The authorship surface ships in two places:
//   1. ReviewDrawer's Authorship tab (per-doc summary) — the
//      "Color text by author" toggle + ContributorBar list.
//   2. AuthorshipPopover (per-paragraph blame) — opens on
//      contextmenu over the editor surface; rendered into the screen
//      with data-testid="authorship-popover".
//
// Both are derivable from the live yDoc's clientAuthors map + the
// editor's Y.XmlFragment; the spec assembles two writers and walks
// each surface.

test.describe('Text — Authorship blame', () => {
    test('two writers → authorship tab + paragraph popover', async ({ browser }) => {
        // Two contexts = two Y.Doc clientIDs. We need both writers'
        // edits to converge on Alice's tab so the popover and
        // contributor list see both authors.

        const itemId = await uploadDocxAsDriveItem(uniqueDocName('authorship-blame'))
        const bob = await createSecondUser('authorship-blame')
        await shareDriveItemWith(itemId, bob)

        const aliceContext = await browser.newContext()
        const bobContext = await browser.newContext()
        try {
            const alicePage = await aliceContext.newPage()
            const bobPage = await bobContext.newPage()

            await loginAs(alicePage, TEST_USER_EMAIL, TEST_USER_PASSWORD)
            await alicePage.goto(`/a/${ORG_SLUG}/text/${itemId}`)
            await waitForEditor(alicePage)
            await expect(alicePage.getByText(FEATURE_DOC_HEADING).first()).toBeVisible()

            await loginAs(bobPage, bob.email, bob.password)
            await bobPage.goto(`/a/${ORG_SLUG}/text/${itemId}`)
            await waitForEditor(bobPage)
            await expect(bobPage.getByText(FEATURE_DOC_HEADING).first()).toBeVisible()

            // Alice and Bob each type into their own paragraph. The
            // contextmenu handler resolves a click to the top-level
            // block index and reads that block's per-author runs, so
            // we need each marker in its own paragraph for the
            // assertion below to scope to a single author.
            const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
            const aliceMarker = `alice unique ${Date.now()}`
            await editorRoot(alicePage).click()
            await alicePage.keyboard.press(`${meta}+End`)
            await alicePage.keyboard.press('Enter')
            await alicePage.keyboard.type(aliceMarker, { delay: 20 })
            await expect(alicePage.getByText(aliceMarker)).toBeVisible()
            await expect(bobPage.getByText(aliceMarker)).toBeVisible()

            const bobMarker = `bob unique ${Date.now()}`
            await editorRoot(bobPage).click()
            await bobPage.keyboard.press(`${meta}+End`)
            await bobPage.keyboard.press('Enter')
            await bobPage.keyboard.type(bobMarker, { delay: 20 })
            await expect(bobPage.getByText(bobMarker)).toBeVisible()
            await expect(alicePage.getByText(bobMarker)).toBeVisible()

            // Wait for clientAuthors to populate with 2+ entries on
            // Alice's tab. The stamper writes one entry per writing
            // clientID; once both Alice and Bob have typed and the
            // delta has fanned out, Alice should see both.
            await expect
                .poll(async () => (await readClientAuthors(alicePage)).length)
                .toBeGreaterThanOrEqual(2)

            // Open Alice's review drawer.
            await alicePage.getByRole('button', { name: 'Open suggestion review drawer' }).click()
            await expect(alicePage.getByText('Suggestions').first()).toBeVisible()

            // Switch to the Authorship tab.
            await alicePage.getByRole('tab', { name: 'Authorship' }).click()

            // The Switch's accessibilityLabel is "Color text by author"
            // and lives at the top of the tab. Its presence pins that
            // we're on the right tab.
            await expect(alicePage.getByLabel('Color text by author')).toBeVisible()

            // At least one contributor row renders a percentage label
            // of the form "<N>%". Use .first() because there are two
            // — one per author — and we only need to pin that the
            // aggregation produced output.
            await expect(alicePage.getByText(/^\d+%$/).first()).toBeVisible()

            // Right-click on Alice's paragraph containing Bob's
            // marker. The contextmenu handler resolves the clicked
            // block to its Y.XmlText and surfaces Bob as a
            // contributor for that paragraph. We click on Bob's text
            // because that's the unambiguous case — Alice never typed
            // into that paragraph, so the popover's per-paragraph
            // attribution must include Bob.
            //
            // The locator finds the <p> wrapper for Bob's marker;
            // click({button: 'right'}) fires a contextmenu event with
            // the marker as target.
            await alicePage.locator(`p:has-text("${bobMarker}")`).click({ button: 'right' })

            const popover = alicePage.locator('[data-testid="authorship-popover"]')
            await expect(popover).toBeVisible()

            // The popover lists contributors with their percentages.
            // We can't easily map user_org_id to a display name in the
            // test, but the popover's ContributorRow renders the
            // percentage in the form "(N%)" — assert at least one
            // such cell exists inside the popover scope.
            await expect(popover.getByText(/\(\d+%\)/).first()).toBeVisible()
        } finally {
            await aliceContext.close()
            await bobContext.close()
        }
    })
})
