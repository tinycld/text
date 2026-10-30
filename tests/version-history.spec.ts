import { expect, type Page, test } from '@playwright/test'
import { editorRoot, openMenubarMenu, openTextDocument } from './_menubar-helpers'

// Version history from the Text File menu: versions are made with
// File → Save version, and every check goes through the history screen.

const meta = process.platform === 'darwin' ? 'Meta' : 'Control'

async function typeAtEnd(page: Page, text: string) {
    await editorRoot(page).click()
    await page.keyboard.press(`${meta}+End`)
    await page.keyboard.press('Enter')
    await page.keyboard.type(text, { delay: 20 })
    await expect(editorRoot(page).getByText(text)).toBeVisible()
}

async function saveVersion(page: Page, label: string) {
    await openMenubarMenu(page, 'File')
    await page.getByRole('menuitem', { name: 'Save version' }).click()
    const input = page.getByPlaceholder('What changed in this version?')
    await input.fill(label)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(input).toBeHidden()
}

async function openHistory(page: Page) {
    await openMenubarMenu(page, 'File')
    await page.getByRole('menuitem', { name: 'Version history' }).click()
}

const versionList = (page: Page) => page.getByRole('list', { name: 'Versions' })
const preview = (page: Page) => page.frameLocator('iframe[title="Version preview"]')

test.describe('Text — version history', () => {
    test('preview, rename and restore from the File menu', async ({ page }) => {
        await openTextDocument(page, 'version-history')
        const first = `first state ${Date.now()}`
        await typeAtEnd(page, first)
        await saveVersion(page, 'Initial draft')

        const second = `second state ${Date.now()}`
        await typeAtEnd(page, second)
        await saveVersion(page, 'Reviewed')

        await openHistory(page)
        // History opened from Text stays in Text: its own route, no Drive
        // sidebar.
        await expect(page).toHaveURL(/\/a\/text\/history\//)
        await expect(page.getByText('Shared with me', { exact: true })).toHaveCount(0)
        await versionList(page).getByRole('button', { name: 'Initial draft' }).click()
        await expect(preview(page).getByText(first)).toBeVisible()
        await expect(preview(page).getByText(second)).toHaveCount(0)

        await page.getByRole('button', { name: 'Rename', exact: true }).click()
        await page.getByPlaceholder('Version name').fill('Approved')
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        await expect(versionList(page).getByRole('button', { name: 'Approved' })).toBeVisible()

        await page.getByRole('button', { name: 'Restore', exact: true }).click()
        await page.getByRole('dialog').getByRole('button', { name: 'Restore', exact: true }).click()

        await expect(editorRoot(page).getByText(first)).toBeVisible()
        await expect(editorRoot(page).getByText(second)).toHaveCount(0)
    })

    test('phone: list screen, then preview screen', async ({ page }) => {
        await openTextDocument(page, 'version-history-phone')
        const text = `phone state ${Date.now()}`
        await typeAtEnd(page, text)
        await saveVersion(page, 'Phone draft')
        await openHistory(page)

        await page.setViewportSize({ width: 390, height: 844 })
        await versionList(page).getByRole('button', { name: 'Phone draft' }).click()
        await expect(versionList(page)).toHaveCount(0)
        await expect(preview(page).getByText(text)).toBeVisible()

        await page.getByRole('button', { name: 'Back' }).click()
        await expect(versionList(page)).toBeVisible()
    })

    test('an automatic version appears after the idle time', async ({ page }) => {
        await openTextDocument(page, 'version-auto')
        const marker = `auto state ${Date.now()}`
        await typeAtEnd(page, marker)

        // TINYCLD_VERSION_IDLE_MS=2000 (playwright.config.ts): the server
        // makes the version itself, after the idle time or when the editor
        // leaves the room. The list is live, so it appears without a reload.
        await openHistory(page)
        const autoRow = versionList(page).getByText('Auto', { exact: true }).first()
        await expect(autoRow).toBeVisible()
        await autoRow.click()
        await expect(preview(page).getByText(marker)).toBeVisible()
    })

    test('show changes marks the paragraph added since the previous version', async ({ page }) => {
        await openTextDocument(page, 'version-compare')
        const kept = `kept line ${Date.now()}`
        await typeAtEnd(page, kept)
        await saveVersion(page, 'Before')
        const added = `added gamma line ${Date.now()}`
        await typeAtEnd(page, added)
        await saveVersion(page, 'After')

        await openHistory(page)
        await versionList(page).getByRole('button', { name: 'After' }).click()
        await page.getByRole('switch', { name: 'Show changes' }).click()
        // Word-level marks are covered by core htmldiff's Go tests; here the
        // whole new paragraph carries the added mark and the old one none.
        await expect(preview(page).locator('[data-diff="ins"]', { hasText: added })).toBeVisible()
        await expect(preview(page).getByText(kept)).toBeVisible()
        await expect(preview(page).locator('[data-diff]', { hasText: kept })).toHaveCount(0)
    })
})
