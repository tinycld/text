import { expect, test } from '@playwright/test'
import { revealDriveRow } from '../../drive/tests/helpers'
import { navigateToPackage } from '../../tinycld/tests/e2e/helpers'
import {
    editorRoot,
    openMenubarMenu,
    openNamedTextDocument,
    uniqueDocName,
} from './_menubar-helpers'

// A restore writes the version's bytes over the document's file. While an
// editor has the document open, its room would overwrite those bytes on the
// next save, so drive refuses the restore and must say why. The editor stays
// open in one tab while a second tab restores from Drive's details panel.
test.describe('Text — restore while the document is open', () => {
    test('restore is refused with a notice that names the open editor', async ({
        page,
        context,
    }) => {
        const name = uniqueDocName('write-guard')
        await openNamedTextDocument(page, name)

        await editorRoot(page).click()
        await page.keyboard.type(`edit ${Date.now()}`, { delay: 20 })
        await openMenubarMenu(page, 'File')
        await page.getByRole('menuitem', { name: 'Save version' }).click()
        await page.getByPlaceholder('What changed in this version?').fill('before restore')
        await page.getByRole('button', { name: 'Save', exact: true }).click()

        const drive = await context.newPage()
        await drive.goto('/')
        await navigateToPackage(drive, 'drive', {
            waitFor: drive.getByTestId('package-sidebar-mounted'),
        })
        const row = await revealDriveRow(drive, name)
        await row.click()
        const panel = drive.getByTestId('drive-detail-panel')
        await panel.getByText('Versions', { exact: true }).click()
        await panel.getByLabel('Restore version 1').click()
        await drive.getByRole('button', { name: 'Restore', exact: true }).click()

        await expect(drive.getByText('this file is open in an editor')).toBeVisible()
    })
})
