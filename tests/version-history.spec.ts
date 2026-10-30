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
        await page.getByRole('radio', { name: 'Compare with previous version' }).click()
        // Word-level marks are covered by core htmldiff's Go tests; here the
        // whole new paragraph carries the added mark and the old one none.
        await expect(preview(page).locator('[data-diff="ins"]', { hasText: added })).toBeVisible()
        await expect(preview(page).getByText(kept)).toBeVisible()
        await expect(preview(page).locator('[data-diff]', { hasText: kept })).toHaveCount(0)
    })

    test('compare a version with the current document, unsaved edits included', async ({
        page,
    }) => {
        await openTextDocument(page, 'version-vs-current')
        const kept = `base line ${Date.now()}`
        await typeAtEnd(page, kept)
        await saveVersion(page, 'Base')
        // Typed after the last version and never saved as one: the compare
        // must include it, because the server saves open edits first.
        const added = `typed since base ${Date.now()}`
        await typeAtEnd(page, added)

        await openHistory(page)
        await versionList(page).getByRole('button', { name: 'Base' }).click()
        await page.getByRole('radio', { name: 'Compare with current document' }).click()
        const addedBlock = preview(page).locator('[data-diff="ins"]', { hasText: added })
        await expect(addedBlock).toBeVisible()
        await expect(preview(page).locator('[data-diff]', { hasText: kept })).toHaveCount(0)
        // The mark must show: a background color, not just an attribute.
        await expect(addedBlock).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    })

    test('⌘/Ctrl-click a second version to compare the two', async ({ page }) => {
        await openTextDocument(page, 'version-pick-base')
        const first = `first pick ${Date.now()}`
        await typeAtEnd(page, first)
        await saveVersion(page, 'Pick one')
        await typeAtEnd(page, `middle pick ${Date.now()}`)
        await saveVersion(page, 'Pick two')
        const last = `last pick ${Date.now()}`
        await typeAtEnd(page, last)
        await saveVersion(page, 'Pick three')

        await openHistory(page)
        await versionList(page).getByRole('button', { name: 'Pick three' }).click()
        // Older base, picked second: the compare still runs older → newer.
        await versionList(page)
            .getByRole('button', { name: 'Pick one' })
            .click({ modifiers: ['ControlOrMeta'] })

        await expect(page.getByText('Comparing with Pick one')).toBeVisible()
        await expect(preview(page).locator('[data-diff="ins"]', { hasText: last })).toBeVisible()
        await expect(preview(page).locator('[data-diff]', { hasText: first })).toHaveCount(0)

        await page.getByRole('button', { name: 'Clear comparison' }).click()
        await expect(page.getByText('Comparing with Pick one')).toHaveCount(0)
        await expect(preview(page).locator('[data-diff]')).toHaveCount(0)
    })

    test('phone: long-press a version to compare it with the one you open', async ({ page }) => {
        await openTextDocument(page, 'version-long-press')
        await typeAtEnd(page, `phone base ${Date.now()}`)
        await saveVersion(page, 'Phone base')
        const later = `phone later ${Date.now()}`
        await typeAtEnd(page, later)
        await saveVersion(page, 'Phone later')
        await openHistory(page)

        await page.setViewportSize({ width: 390, height: 844 })
        // A held press is a long-press on web too (Pressable's onLongPress).
        await versionList(page).getByRole('button', { name: 'Phone base' }).click({ delay: 800 })
        await versionList(page).getByRole('button', { name: 'Phone later' }).click()
        await expect(page.getByText('Comparing with Phone base')).toBeVisible()
        await expect(preview(page).locator('[data-diff="ins"]', { hasText: later })).toBeVisible()
    })
})
