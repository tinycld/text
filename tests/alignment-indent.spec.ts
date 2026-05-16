import { expect, test } from '@playwright/test'
import { editorRoot, openFreshTextDocument, TEXT_TEST_TIMEOUT } from './_menubar-helpers'

// Alignment + indent v1: paragraphs (and headings) can be aligned
// left / center / right / justify and their left-indent level can
// be nudged up / down by one. This spec exercises the editor-side
// commands; the DOCX round-trip is covered by Go unit tests in
// server/translate/alignment_indent_test.go.
//
// NOT EXECUTED IN CI for this PR — listed for future runs once we
// stabilise the realtime / Playwright harness for alignment-indent.

test.describe('Text — Alignment & indent', () => {
    test.setTimeout(TEXT_TEST_TIMEOUT)

    test('clicking Center alignment applies text-align:center to the paragraph', async ({
        page,
    }) => {
        await openFreshTextDocument(page, 'alignment')
        await editorRoot(page).click()
        await page.keyboard.type('Aligned paragraph')

        await page.getByRole('button', { name: 'Align center', exact: true }).click()

        // The TextAlign extension renders inline style="text-align: center"
        // onto the surrounding <p>. We pick the paragraph that contains the
        // typed text to avoid asserting on empty boilerplate paragraphs.
        const paragraph = editorRoot(page).locator('p', { hasText: 'Aligned paragraph' }).first()
        await expect(paragraph).toHaveAttribute('style', /text-align:\s*center/)
    })

    test('clicking Increase indent twice indents the paragraph by two levels', async ({ page }) => {
        await openFreshTextDocument(page, 'indent')
        await editorRoot(page).click()
        await page.keyboard.type('Indented paragraph')

        const indentBtn = page.getByRole('button', { name: 'Increase indent', exact: true })
        await indentBtn.click()
        await indentBtn.click()

        // BlockIndent renders data-indent + padding-inline-start as
        // inline style. data-indent is the easier assertion target
        // because the style attribute may include other declarations.
        const paragraph = editorRoot(page).locator('p', { hasText: 'Indented paragraph' }).first()
        await expect(paragraph).toHaveAttribute('data-indent', '2')
    })

    test('Cmd+Shift+R applies right alignment via keyboard shortcut', async ({ page }) => {
        await openFreshTextDocument(page, 'right-shortcut')
        await editorRoot(page).click()
        await page.keyboard.type('Right via shortcut')

        // Mod-Shift-R is bound by @tiptap/extension-text-align directly;
        // we don't need to dispatch through the toolbar.
        await page.keyboard.press('Meta+Shift+R')

        const paragraph = editorRoot(page).locator('p', { hasText: 'Right via shortcut' }).first()
        await expect(paragraph).toHaveAttribute('style', /text-align:\s*right/)
    })
})
