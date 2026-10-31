import { expect, type Page } from '@playwright/test'
import { navigateToPackage } from '../../tinycld/tests/e2e/helpers'
import { editorRoot, openMenubarMenu } from './_menubar-helpers'

// Shared by the version-history specs.

const meta = process.platform === 'darwin' ? 'Meta' : 'Control'

export async function typeAtEnd(page: Page, text: string) {
    await editorRoot(page).click()
    await page.keyboard.press(`${meta}+End`)
    await page.keyboard.press('Enter')
    await page.keyboard.type(text, { delay: 20 })
    await expect(editorRoot(page).getByText(text)).toBeVisible()
}

export async function saveVersion(page: Page, label: string) {
    await openMenubarMenu(page, 'File')
    await page.getByRole('menuitem', { name: 'Save version' }).click()
    const input = page.getByPlaceholder('What changed in this version?')
    await input.fill(label)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(input).toBeHidden()
}

export async function openHistory(page: Page) {
    await openMenubarMenu(page, 'File')
    await page.getByRole('menuitem', { name: 'Version history' }).click()
}

export const versionList = (page: Page) => page.getByRole('list', { name: 'Versions' })
export const preview = (page: Page) => page.frameLocator('iframe[title="Version preview"]')

export const AUTO_VERSIONS_ITEM = 'Automatically version while editing'
export const AUTO_VERSIONS_SWITCH = 'Automatically version documents while editing'

export const autoVersionsItem = (page: Page) =>
    page.getByRole('menuitemcheckbox', { name: AUTO_VERSIONS_ITEM })

// Turns automatic versions on for the open document from its File menu.
export async function turnOnAutoVersions(page: Page) {
    await openMenubarMenu(page, 'File')
    const item = autoVersionsItem(page)
    await expect(item).not.toBeChecked()
    await item.click()
    await expect(item).toBeChecked()
    await page.keyboard.press('Escape')
}

// Settings → Drive → Versions.
export async function openVersionsSettings(page: Page) {
    await navigateToPackage(page, 'settings')
    await page.getByText('Versions', { exact: true }).first().click()
    await expect(page.getByRole('switch', { name: AUTO_VERSIONS_SWITCH })).toBeVisible()
}
