import { expect, test } from '@playwright/test'
import { editorRoot, openFreshTextDocument, TEXT_TEST_TIMEOUT } from './_menubar-helpers'

// Image wrap toolbar v1: clicking a selected image surfaces a row of
// four mode buttons (inline / left / right / break) above the image.
// Clicking a button writes the corresponding `wrap` attribute via
// updateAttributes; the wrapper span carries that as `data-wrap`,
// which the CSS in editor-content-styles.ts uses to apply float and
// margin behavior. Inline mode is the absence-of-attribute case.
//
// This spec covers the editor-side interaction. The DOCX round-trip
// for each mode (including byte-stable absence-of-attr for inline) is
// covered by the Go test TestPMJSONToDocx_ImageWrapRoundTrip in
// server/translate/image_wrap_test.go — the Go layer exercises both
// directions of the parser/emitter pair more thoroughly than a single
// Playwright run can reach.

// 4×3 PNG so the wrapper has a visible box for the toolbar to anchor
// above. Larger than the resize spec's 1×2 because we're not testing
// drag — we want a click target that doesn't collapse to a sliver.
const PNG_4x3_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAAFElEQVR42mP8z8DwnwEJMI4qogIAfAQDAcXgQ4MAAAAASUVORK5CYII='

function makePngBuffer(): Buffer {
    return Buffer.from(PNG_4x3_BASE64, 'base64')
}

test.describe('Text — Image wrap toolbar', () => {
    test.setTimeout(TEXT_TEST_TIMEOUT)

    test('each toolbar button writes the matching data-wrap attribute', async ({ page }) => {
        await openFreshTextDocument(page, 'image-wrap')

        await editorRoot(page).click()
        await page.keyboard.press('End')

        // Insert an image via the toolbar — mirrors image-resize.spec.ts.
        const fileChooserPromise = page.waitForEvent('filechooser')
        await page.getByRole('button', { name: 'Insert image', exact: true }).click()
        const chooser = await fileChooserPromise
        await chooser.setFiles({
            name: 'image-wrap.png',
            mimeType: 'image/png',
            buffer: makePngBuffer(),
        })

        const inserted = editorRoot(page).locator('img[src*="/api/files/drive_items/"]').first()
        await expect(inserted).toBeVisible({ timeout: 30_000 })

        // Selecting the image flips the NodeView's `selected` prop and
        // mounts the toolbar + resize handles.
        await inserted.click()
        const toolbar = editorRoot(page).locator('[data-image-wrap-toolbar]').first()
        await expect(toolbar).toBeVisible({ timeout: 5_000 })

        // All four mode buttons render in order.
        await expect(toolbar.locator('[data-image-wrap-mode]')).toHaveCount(4)
        for (const mode of ['inline', 'left', 'right', 'break']) {
            await expect(toolbar.locator(`[data-image-wrap-mode="${mode}"]`)).toBeVisible()
        }

        const wrapper = editorRoot(page)
            .locator('[data-node-view-wrapper]')
            .filter({ has: inserted })
            .first()

        // Click each non-inline button and assert the attribute lands.
        for (const mode of ['left', 'right', 'break'] as const) {
            await toolbar.locator(`[data-image-wrap-mode="${mode}"]`).click()
            // Yjs / PM transactions are sync within a single click, so
            // the data attribute should be present immediately. Use a
            // short retry to absorb any layout flush.
            await expect(wrapper).toHaveAttribute('data-wrap', mode, { timeout: 2_000 })
            // The active button paints with the primary color background.
            // We assert aria-pressed rather than computed style so the
            // test isn't tied to the exact theme color values.
            await expect(toolbar.locator(`[data-image-wrap-mode="${mode}"]`)).toHaveAttribute(
                'aria-pressed',
                'true'
            )
        }

        // Click inline — the wrapper should LOSE the data-wrap attribute
        // entirely (inline mode = absence-of-attribute).
        await toolbar.locator('[data-image-wrap-mode="inline"]').click()
        await expect(wrapper).not.toHaveAttribute('data-wrap', /.*/, { timeout: 2_000 })
        await expect(toolbar.locator('[data-image-wrap-mode="inline"]')).toHaveAttribute(
            'aria-pressed',
            'true'
        )
    })

    test('wrap mode persists through reload (Yjs round-trip)', async ({ page }) => {
        await openFreshTextDocument(page, 'image-wrap-persist')
        await editorRoot(page).click()
        await page.keyboard.press('End')

        const fileChooserPromise = page.waitForEvent('filechooser')
        await page.getByRole('button', { name: 'Insert image', exact: true }).click()
        const chooser = await fileChooserPromise
        await chooser.setFiles({
            name: 'image-wrap-persist.png',
            mimeType: 'image/png',
            buffer: makePngBuffer(),
        })

        const inserted = editorRoot(page).locator('img[src*="/api/files/drive_items/"]').first()
        await expect(inserted).toBeVisible({ timeout: 30_000 })
        await inserted.click()
        await editorRoot(page).locator('[data-image-wrap-mode="break"]').click()

        const wrapper = editorRoot(page)
            .locator('[data-node-view-wrapper]')
            .filter({ has: inserted })
            .first()
        await expect(wrapper).toHaveAttribute('data-wrap', 'break', { timeout: 2_000 })

        // Force a reload — the doc must hydrate from the server's Y.Doc
        // state and end up back at wrap=break. If the schema's parseHTML
        // whitelist or the PM-side attr serialization regressed, the
        // attribute would arrive missing or 'inline' on this round-trip.
        await page.reload()
        const reloaded = editorRoot(page).locator('img[src*="/api/files/drive_items/"]').first()
        await expect(reloaded).toBeVisible({ timeout: 30_000 })
        const reloadedWrapper = editorRoot(page)
            .locator('[data-node-view-wrapper]')
            .filter({ has: reloaded })
            .first()
        await expect(reloadedWrapper).toHaveAttribute('data-wrap', 'break', { timeout: 5_000 })
    })
})
