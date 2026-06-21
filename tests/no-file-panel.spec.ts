import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { login, navigateToPackage, ORG_SLUG } from '../../tinycld/tests/e2e/helpers'
import { FEATURE_DOC_HEADING } from './_menubar-helpers'

// The text index renders the shared NoFilePanel whenever the user lands
// on /text without a deep-link (the rail otherwise reopens the last
// edited document). Covers: panel is visible, three cards render with
// the right copy, the New / Browse Recent / Browse All actions all
// navigate, and Upload drops the file into a new document the user
// can immediately edit.
test.describe('Text No-File panel', () => {
    test.beforeEach(async ({ page }) => {
        await login(page)
        await navigateToPackage(page, 'text')
    })

    test('renders the headline, sublabel, and three CTA cards', async ({ page }) => {
        await expect(page.getByRole('heading', { level: 1, name: 'A blank page.' })).toBeVisible({
            timeout: 30_000,
        })
        await expect(page.getByText('Where the next thought lands.')).toBeVisible()

        await expect(page.getByRole('button', { name: 'New document' })).toBeVisible()
        // The web upload card renders as a <label> wrapping a hidden
        // <input type="file">, not a button, so we assert by visible text.
        await expect(page.getByText('Upload files', { exact: true })).toBeVisible()
        await expect(page.getByRole('link', { name: 'Recent' })).toBeVisible()
        await expect(page.getByRole('link', { name: 'All' })).toBeVisible()

        // Hint copy underneath the Upload card surfaces the accepted formats.
        await expect(page.getByText('.docx, .md, .txt')).toBeVisible()
    })

    test('New document creates a document and opens it', async ({ page }) => {
        await expect(page.getByRole('heading', { level: 1, name: 'A blank page.' })).toBeVisible({
            timeout: 30_000,
        })
        await page.getByRole('button', { name: 'New document' }).click()

        await page.waitForURL(/\/text\/[^/]+$/, { timeout: 75_000 })
        await expect(page.locator('.tinycld-document-editor .ProseMirror')).toBeVisible({
            timeout: 75_000,
        })
    })

    test('Upload docx creates a document whose content is editable', async ({ page }) => {
        await expect(page.getByRole('heading', { level: 1, name: 'A blank page.' })).toBeVisible({
            timeout: 30_000,
        })

        // The upload card hides its <input type="file"> behind a label
        // wrapper; target the panel's input by testid — a bare
        // input[type="file"] selector also matches frozen sibling screens the
        // app shell keeps mounted (freezeOnBlur), tripping strict mode. The
        // fixture is the seeded tests/assets/feature-test.docx — the same one
        // the other text e2e specs use, with a known "Sample Document"
        // heading at the top.
        const fixturePath = join(import.meta.dirname, 'assets', 'feature-test.docx')
        await page.getByTestId('nofile-upload-input').setInputFiles(fixturePath)

        // Single .docx upload routes straight to the editor.
        await page.waitForURL(/\/text\/[^/]+$/, { timeout: 75_000 })
        await expect(page.locator('.tinycld-document-editor .ProseMirror')).toBeVisible({
            timeout: 75_000,
        })

        // The fixture's H1 must render in the editor — proves the upload
        // landed and the editor loaded it for editing.
        await expect(page.getByText(FEATURE_DOC_HEADING).first()).toBeVisible({
            timeout: 30_000,
        })
    })

    test('Browse Recent navigates to drive recent view', async ({ page }) => {
        await expect(page.getByRole('heading', { level: 1, name: 'A blank page.' })).toBeVisible({
            timeout: 30_000,
        })
        await page.getByRole('link', { name: 'Recent' }).click()
        await page.waitForURL(new RegExp(`/a/${ORG_SLUG}/drive/recent/?$`), {
            timeout: 15_000,
        })
    })

    test('Browse All navigates to drive root', async ({ page }) => {
        await expect(page.getByRole('heading', { level: 1, name: 'A blank page.' })).toBeVisible({
            timeout: 30_000,
        })
        await page.getByRole('link', { name: 'All' }).click()
        await page.waitForURL(new RegExp(`/a/${ORG_SLUG}/drive/?$`), {
            timeout: 15_000,
        })
    })

    test('the rail reopens the last edited document', async ({ page }) => {
        // Create a document so the rail caches a deep-link.
        await expect(page.getByRole('heading', { level: 1, name: 'A blank page.' })).toBeVisible({
            timeout: 30_000,
        })
        await page.getByRole('button', { name: 'New document' }).click()
        await page.waitForURL(/\/text\/[^/]+$/, { timeout: 75_000 })
        const editorUrl = page.url()

        // Detour through home, then click the Text rail icon — we should
        // land back on the document we just created, not on the panel.
        await page.goto(`/a/${ORG_SLUG}`)
        await page.getByTestId('nav-text').click()
        await page.waitForURL(editorUrl, { timeout: 15_000 })
        await expect(page.locator('.tinycld-document-editor .ProseMirror')).toBeVisible({
            timeout: 30_000,
        })
    })
})
