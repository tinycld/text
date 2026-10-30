import { expect, test } from '@playwright/test'
import {
    navigateToPackage,
    TEST_USER_PASSWORD,
    TEST_USER_USERNAME,
} from '../../tinycld/tests/e2e/helpers'
import {
    editorRoot,
    openMenubarMenu,
    uniqueDocName,
    uploadDocxAsDriveItem,
    waitForEditor,
} from './_menubar-helpers'
import { createSecondUser, loginAs, shareDriveItemWith } from './helpers/seed-multi-user'

// A viewer can open the history and preview a version, but Restore and
// Rename need write access, so the screen does not offer them. The second
// user and the share are seeded the way the other multi-user specs do; the
// version itself is made through the UI.
test.describe('Text — version history for a viewer', () => {
    test('a viewer previews versions without Restore or Rename', async ({ browser }) => {
        const docName = uniqueDocName('version-viewer')
        const itemId = await uploadDocxAsDriveItem(docName)
        const viewer = await createSecondUser('version-viewer')
        await shareDriveItemWith(itemId, viewer, 'viewer')

        const ownerCtx = await browser.newContext()
        const viewerCtx = await browser.newContext()
        try {
            const owner = await ownerCtx.newPage()
            await loginAs(owner, TEST_USER_USERNAME, TEST_USER_PASSWORD)
            await owner.goto(`/a/text/${itemId}`)
            await waitForEditor(owner)
            await editorRoot(owner).click()
            await openMenubarMenu(owner, 'File')
            await owner.getByRole('menuitem', { name: 'Save version' }).click()
            const input = owner.getByPlaceholder('What changed in this version?')
            await input.fill('Shared draft')
            await owner.getByRole('button', { name: 'Save', exact: true }).click()
            await expect(input).toBeHidden()

            // Text shows no menu bar to a viewer, so the viewer opens the
            // history from Drive's info panel.
            const page = await viewerCtx.newPage()
            await loginAs(page, viewer.username, viewer.password)
            await navigateToPackage(page, 'drive')
            await page.getByPlaceholder('Search in Files').fill(docName)
            await page
                .getByLabel(new RegExp(`^${docName.replace('.', '\\.')} `))
                .first()
                .click()
            await page
                .getByTestId('drive-detail-panel')
                .getByText('Versions', { exact: true })
                .click()
            await page.getByRole('button', { name: 'Open version history' }).click()

            await page
                .getByRole('list', { name: 'Versions' })
                .getByRole('button', { name: 'Shared draft' })
                .click()
            await expect(page.locator('iframe[title="Version preview"]')).toBeVisible()
            await expect(page.getByRole('button', { name: 'Restore', exact: true })).toHaveCount(0)
            await expect(page.getByRole('button', { name: 'Rename', exact: true })).toHaveCount(0)
        } finally {
            await ownerCtx.close()
            await viewerCtx.close()
        }
    })
})
