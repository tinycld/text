import { expect, test } from '@playwright/test'
import { editorRoot, openMenubarMenu, openTextDocument } from './_menubar-helpers'

// Regression: a line break (Shift+Enter) made the server's docx writer
// fail with `unsupported inline node "hardBreak"`, so no save of the
// document reached storage. Save version flushes the live document first,
// so it fails the same way the background save did.
test.describe('Text — line breaks', () => {
    test('a document with a line break saves and keeps the break', async ({ page }) => {
        await openTextDocument(page, 'line-break')
        const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
        const stamp = Date.now()
        await editorRoot(page).click()
        await page.keyboard.press(`${meta}+End`)
        await page.keyboard.press('Enter')
        await page.keyboard.type(`before break ${stamp}`, { delay: 20 })
        await page.keyboard.press('Shift+Enter')
        await page.keyboard.type(`after break ${stamp}`, { delay: 20 })
        await expect(editorRoot(page).locator('br').first()).toBeAttached()

        await openMenubarMenu(page, 'File')
        await page.getByRole('menuitem', { name: 'Save version' }).click()
        const input = page.getByPlaceholder('What changed in this version?')
        await input.fill('With a line break')
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        await expect(input).toBeHidden()

        await openMenubarMenu(page, 'File')
        await page.getByRole('menuitem', { name: 'Version history' }).click()
        await page
            .getByRole('list', { name: 'Versions' })
            .getByRole('button', { name: 'With a line break' })
            .click()
        const paragraph = page
            .frameLocator('iframe[title="Version preview"]')
            .locator('p', { hasText: `before break ${stamp}` })
        await expect(paragraph).toContainText(`after break ${stamp}`)
        await expect(paragraph.locator('br')).toHaveCount(1)
    })
})
