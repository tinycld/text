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
// editor has the document open, drive first closes its room, which saves the
// last edits, and then writes; the editor reconnects and reloads with the
// restored content. The editor stays open in one tab while a second tab
// restores from Drive's details panel.
test.describe('Text — restore while the document is open', () => {
    test('the open editor reloads with the restored version', async ({ page, context }) => {
        const name = uniqueDocName('restore-open')
        await openNamedTextDocument(page, name)

        const kept = `kept ${Date.now()}`
        await editorRoot(page).click()
        await page.keyboard.type(kept, { delay: 20 })
        await openMenubarMenu(page, 'File')
        await page.getByRole('menuitem', { name: 'Save version' }).click()
        const versionLabel = page.getByPlaceholder('What changed in this version?')
        await versionLabel.fill('before restore')
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        await expect(versionLabel).toBeHidden()

        // The dialog takes the focus; give it back to the editor.
        const replaced = `replaced ${Date.now()}`
        await editorRoot(page).click()
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End')
        await page.keyboard.press('Enter')
        await page.keyboard.type(replaced, { delay: 20 })
        await expect(editorRoot(page).getByText(replaced)).toBeVisible()

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

        await expect(editorRoot(page).getByText(replaced)).toHaveCount(0)
        await expect(editorRoot(page).getByText(kept)).toBeVisible()
    })
})
