import { expect, test } from '@playwright/test'
import { editorRoot, openFreshTextDocument, TEXT_TEST_TIMEOUT } from './_menubar-helpers'

// Image resize v1: clicking a selected image surfaces three drag
// handles; dragging the corner handle preserves the aspect ratio and
// persists the new size into the PM image node's width/height attrs.
// We verify the change survives a full page reload to prove it round-
// tripped through Y.Doc / PocketBase, not just into local React state.

// 1×2 PNG (1 px wide, 2 px tall — natural ratio 0.5 means corner-drag
// produces a clearly distinct width and height).
const PNG_1x2_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAACCAQAAAAW58hHAAAADklEQVR42mP4z8DwHwAFAAH/UQVwhgAAAABJRU5ErkJggg=='

function makePngBuffer(): Buffer {
    return Buffer.from(PNG_1x2_BASE64, 'base64')
}

test.describe('Text — Image resize', () => {
    test.setTimeout(TEXT_TEST_TIMEOUT)

    test('dragging the corner handle resizes the image and persists across reload', async ({
        page,
    }) => {
        await openFreshTextDocument(page, 'image-resize')

        await editorRoot(page).click()
        await page.keyboard.press('End')

        // Insert an image via the toolbar (mirrors toolbar-image-insert
        // spec). After insert, the editor lands the caret AFTER the
        // image — we click the <img> to select it and surface the
        // resize handles.
        const fileChooserPromise = page.waitForEvent('filechooser')
        await page.getByRole('button', { name: 'Insert image', exact: true }).click()
        const chooser = await fileChooserPromise
        await chooser.setFiles({
            name: 'image-resize.png',
            mimeType: 'image/png',
            buffer: makePngBuffer(),
        })

        const inserted = editorRoot(page).locator('img[src*="/api/files/drive_items/"]').first()
        await expect(inserted).toBeVisible({ timeout: 30_000 })

        // ProseMirror needs us to click the image to drop a NodeSelection
        // onto it — that's what flips ReactNodeViewRenderer's `selected`
        // prop and mounts the handles.
        await inserted.click()
        const cornerHandle = editorRoot(page).locator('[data-image-handle="corner"]').first()
        await expect(cornerHandle).toBeVisible({ timeout: 5_000 })

        const startBox = await inserted.boundingBox()
        if (!startBox) throw new Error('image has no bounding box')

        // Drag the corner handle right + down by 200px. The pointermove
        // updates `liveSize`; pointerup commits via updateAttributes,
        // which Yjs mirrors into the room.
        const handleBox = await cornerHandle.boundingBox()
        if (!handleBox) throw new Error('handle has no bounding box')
        const handleX = handleBox.x + handleBox.width / 2
        const handleY = handleBox.y + handleBox.height / 2
        await page.mouse.move(handleX, handleY)
        await page.mouse.down()
        await page.mouse.move(handleX + 200, handleY + 200, { steps: 10 })
        await page.mouse.up()

        // Width must have grown from the natural 1px to at least the
        // 32px minimum. The exact value is an integer set by
        // clampImageSize; we only assert it changed and is in range.
        const widthAttr = await inserted.getAttribute('width')
        expect(widthAttr).not.toBeNull()
        const widthPx = Number.parseInt(widthAttr ?? '0', 10)
        expect(widthPx).toBeGreaterThanOrEqual(32)

        // Reload the page and re-open the same document. The committed
        // dimensions should still be on the rendered <img>.
        await page.reload()
        const reloaded = editorRoot(page).locator('img[src*="/api/files/drive_items/"]').first()
        await expect(reloaded).toBeVisible({ timeout: 30_000 })
        const persistedWidth = await reloaded.getAttribute('width')
        expect(persistedWidth).toBe(widthAttr)
    })
})
