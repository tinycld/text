import { expect, test } from '@playwright/test'
import { login } from '../../tinycld/tests/e2e/helpers'
import { openMenubarMenu, openTextDocument } from './_menubar-helpers'
import {
    AUTO_VERSIONS_SWITCH,
    autoVersionsItem,
    openHistory,
    openVersionsSettings,
    turnOnAutoVersions,
    typeAtEnd,
    versionList,
} from './_version-helpers'

// Automatic versions are opt-in: off by default, on per document from the
// File menu, or on for every document without its own choice from
// Settings → Drive → Versions.
test.describe('Text — automatic versions setting', () => {
    test('the File menu item turns automatic versions on for one document', async ({ page }) => {
        await openTextDocument(page, 'auto-on')
        await turnOnAutoVersions(page)
        // Toggling only the flag must not close the open document: typing
        // still works, and its automatic version arrives.
        await typeAtEnd(page, `auto on ${Date.now()}`)
        await openHistory(page)
        await expect(versionList(page).getByText('Auto', { exact: true }).first()).toBeVisible()
    })

    test('the org setting turns automatic versions on for documents without their own choice', async ({
        page,
    }) => {
        // The e2e database is shared: put the org switch back at the end.
        await login(page)
        await openVersionsSettings(page)
        const orgSwitch = page.getByRole('switch', { name: AUTO_VERSIONS_SWITCH })
        await orgSwitch.click()
        await expect(orgSwitch).toBeChecked()
        try {
            await openTextDocument(page, 'auto-org')
            await openMenubarMenu(page, 'File')
            await expect(autoVersionsItem(page)).toBeChecked()
            await page.keyboard.press('Escape')
            await typeAtEnd(page, `org on ${Date.now()}`)
            await openHistory(page)
            await expect(versionList(page).getByText('Auto', { exact: true }).first()).toBeVisible()
        } finally {
            await openVersionsSettings(page)
            const sw = page.getByRole('switch', { name: AUTO_VERSIONS_SWITCH })
            if (await sw.isChecked()) await sw.click()
            await expect(sw).not.toBeChecked()
        }
    })
})
