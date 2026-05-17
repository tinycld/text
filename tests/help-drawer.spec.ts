import { expect, test } from '@playwright/test'
import { ORG_SLUG } from '../../../../tests/e2e/helpers'
import {
    editorRoot,
    openFreshTextDocument,
    openMenubarMenu,
    TEXT_TEST_TIMEOUT,
} from './_menubar-helpers'

// Help drawer package-index mode: the Help menu's "Browse text help"
// item now opens an in-app drawer with a topic list (no route change).
// Selecting a topic switches the drawer to topic mode with a back
// arrow; the back arrow returns to the package list without remount.
// A subtle "Read all tinycld help" link in both modes navigates to
// the routed /a/<org>/help hub and dismisses the drawer.
//
// NOT EXECUTED IN CI for this PR — the main session validates after
// merging into the text package's main branch.

test.describe('Text — Help drawer package-index mode', () => {
    test.setTimeout(TEXT_TEST_TIMEOUT)

    test('Help → Browse text help opens the drawer with the text topic list', async ({ page }) => {
        await openFreshTextDocument(page, 'help-drawer-open')
        await editorRoot(page).click()

        await openMenubarMenu(page, 'Help')
        await page.getByRole('menuitem', { name: 'Browse text help' }).click()

        // The drawer is up with the package's topic list. At minimum we
        // expect a few well-known text topics — "Slash menu" and
        // "Document templates" — to be visible as row titles.
        await expect(page.getByText(/Slash menu/i).first()).toBeVisible()
        await expect(page.getByText(/Document templates/i).first()).toBeVisible()
    })

    test('clicking a row switches to topic mode and shows a back arrow', async ({ page }) => {
        await openFreshTextDocument(page, 'help-drawer-row')
        await editorRoot(page).click()

        await openMenubarMenu(page, 'Help')
        await page.getByRole('menuitem', { name: 'Browse text help' }).click()

        await page.getByText(/Document templates/i).first().click()

        // Topic body is now showing — assert on text from the rendered
        // markdown. Every templates topic mentions "template" repeatedly.
        await expect(page.getByText(/template/i).first()).toBeVisible()

        const backArrow = page.getByRole('button', { name: 'Back to package help' })
        await expect(backArrow).toBeVisible()
    })

    test('back arrow returns to the package list without leaving the drawer', async ({ page }) => {
        await openFreshTextDocument(page, 'help-drawer-back')
        await editorRoot(page).click()

        await openMenubarMenu(page, 'Help')
        await page.getByRole('menuitem', { name: 'Browse text help' }).click()
        await page.getByText(/Document templates/i).first().click()

        await page.getByRole('button', { name: 'Back to package help' }).click()

        // The Slash menu row is once again visible — same package
        // index we came from, no route change.
        await expect(page.getByText(/Slash menu/i).first()).toBeVisible()
    })

    test('"Read all tinycld help" navigates to the routed hub and dismisses the drawer', async ({
        page,
    }) => {
        await openFreshTextDocument(page, 'help-drawer-readall')
        await editorRoot(page).click()

        await openMenubarMenu(page, 'Help')
        await page.getByRole('menuitem', { name: 'Browse text help' }).click()

        await page.getByText(/Read all tinycld help/i).click()

        await expect(page).toHaveURL(new RegExp(`/a/${ORG_SLUG}/help`))
        // The drawer dismissed. Asserting on the body text won't work
        // because the destination /help page also lists the text
        // package's topics — checking for the "Read all" link itself
        // (a drawer-only affordance) is the right signal.
        await expect(
            page.getByRole('link', { name: /Read all tinycld help/i })
        ).toHaveCount(0)
    })
})
