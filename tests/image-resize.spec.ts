import { expect, test } from '@playwright/test'
import { editorRoot, openFreshTextDocument, TEXT_TEST_TIMEOUT } from './_menubar-helpers'

// Image resize v1: clicking a selected image surfaces three drag
// handles; dragging the corner handle preserves the aspect ratio and
// persists the new size into the PM image node's width/height attrs.
//
// This spec covers the editor-side resize interaction. The full DOCX
// round-trip (width/height through <wp:extent> EMUs) is covered by Go
// unit tests in server/translate/image_dimensions_test.go — those
// exercise the same parser/emitter pair the server bootstrap +
// flush go through, with finer granularity than a Playwright run can
// reach.

// 1×2 PNG (1 px wide, 2 px tall — natural ratio 0.5 means corner-drag
// produces a clearly distinct width and height).
const PNG_1x2_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAACCAQAAAAW58hHAAAADklEQVR42mP4z8DwHwAFAAH/UQVwhgAAAABJRU5ErkJggg=='

function makePngBuffer(): Buffer {
    return Buffer.from(PNG_1x2_BASE64, 'base64')
}

// 100×50 PNG — a natural aspect ratio that's tall enough to exercise
// both the horizontal-drag (width-only) skew path and the reset path
// without the min-size clamp obscuring what we measure.
const PNG_100x50_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAGQAAAAyCAQAAAC2zsK6AAAAFElEQVR42u3BAQ0AAADCoPdPbQ8HFAAAACQNDAABNVlPlAAAAABJRU5ErkJggg=='

function make100x50PngBuffer(): Buffer {
    return Buffer.from(PNG_100x50_BASE64, 'base64')
}

test.describe('Text — Image resize', () => {
    test.setTimeout(TEXT_TEST_TIMEOUT)

    test('dragging the corner handle resizes the image in place', async ({ page }) => {
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

        // Drag the corner handle right + down by 200px. The pointermove
        // updates liveSize; pointerup commits via updateAttributes,
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
        // clampImageSize; we assert it landed in the legal range and
        // that the height attr was committed alongside (corner-drag
        // commits both axes).
        const widthAttr = await inserted.getAttribute('width')
        const heightAttr = await inserted.getAttribute('height')
        expect(widthAttr).not.toBeNull()
        expect(heightAttr).not.toBeNull()
        const widthPx = Number.parseInt(widthAttr ?? '0', 10)
        const heightPx = Number.parseInt(heightAttr ?? '0', 10)
        expect(widthPx).toBeGreaterThanOrEqual(32)
        expect(heightPx).toBeGreaterThanOrEqual(32)

        // Orthogonality regression: flipping the wrap mode must not
        // clear the width/height attrs the drag just committed. The
        // toolbar's onChange handler is wired to only send `{ wrap }`
        // — the plan's §8 invariant. If a future refactor bundled
        // dimensions back into that updateAttributes call, the
        // concurrent-resize race would no longer be benign.
        const toolbar = editorRoot(page).locator('[data-image-wrap-toolbar]').first()
        await expect(toolbar).toBeVisible({ timeout: 5_000 })
        await toolbar.locator('[data-image-wrap-mode="left"]').click()

        const widthAfter = Number.parseInt((await inserted.getAttribute('width')) ?? '0', 10)
        const heightAfter = Number.parseInt((await inserted.getAttribute('height')) ?? '0', 10)
        expect(widthAfter).toBe(widthPx)
        expect(heightAfter).toBe(heightPx)
    })

    test('reset-size button restores the natural dimensions after a skew', async ({ page }) => {
        // Drag the right-edge handle to grow the width without touching
        // the height — that's how a user accidentally produces a skewed
        // image (e.g. a 100×50 source dragged to 300×50). The reset
        // button on the wrap toolbar must restore the natural 100×50
        // dimensions in one click, even when the wrapper currently
        // carries a non-natural attr pair.
        await openFreshTextDocument(page, 'image-resize-reset')
        await editorRoot(page).click()
        await page.keyboard.press('End')

        const fileChooserPromise = page.waitForEvent('filechooser')
        await page.getByRole('button', { name: 'Insert image', exact: true }).click()
        const chooser = await fileChooserPromise
        await chooser.setFiles({
            name: 'reset-fixture.png',
            mimeType: 'image/png',
            buffer: make100x50PngBuffer(),
        })

        const inserted = editorRoot(page).locator('img[src*="/api/files/drive_items/"]').first()
        await expect(inserted).toBeVisible({ timeout: 30_000 })

        // Wait until the image has actually loaded so naturalWidth /
        // naturalHeight are non-zero. Without this the toolbar's
        // canReset gate would still be false even after the drag.
        await page.waitForFunction(
            () => {
                const img = document.querySelector<HTMLImageElement>(
                    '.ProseMirror img[src*="/api/files/drive_items/"]'
                )
                return img !== null && img.complete && img.naturalWidth > 0
            },
            { timeout: 30_000 }
        )

        await inserted.click()
        const rightHandle = editorRoot(page).locator('[data-image-handle="right"]').first()
        await expect(rightHandle).toBeVisible({ timeout: 5_000 })

        // Horizontal-only drag: width grows, height stays — that's the
        // skew we want the reset button to undo.
        const handleBox = await rightHandle.boundingBox()
        if (!handleBox) throw new Error('right handle has no bounding box')
        const handleX = handleBox.x + handleBox.width / 2
        const handleY = handleBox.y + handleBox.height / 2
        await page.mouse.move(handleX, handleY)
        await page.mouse.down()
        await page.mouse.move(handleX + 200, handleY, { steps: 10 })
        await page.mouse.up()

        const widthBeforeReset = Number.parseInt((await inserted.getAttribute('width')) ?? '0', 10)
        const heightBeforeReset = Number.parseInt((await inserted.getAttribute('height')) ?? '0', 10)
        // Sanity: the right-edge drag produced a skewed pair — width
        // grew, height stayed at the natural value (50). If clampImageSize
        // ever started touching the height on a horizontal drag this
        // assertion would catch it.
        expect(widthBeforeReset).toBeGreaterThan(200)
        expect(heightBeforeReset).toBe(50)

        const resetButton = editorRoot(page).locator('[data-image-wrap-reset]').first()
        await expect(resetButton).toBeVisible({ timeout: 5_000 })
        await expect(resetButton).toBeEnabled()
        await resetButton.click()

        const widthAfter = Number.parseInt((await inserted.getAttribute('width')) ?? '0', 10)
        const heightAfter = Number.parseInt((await inserted.getAttribute('height')) ?? '0', 10)
        expect(widthAfter).toBe(100)
        expect(heightAfter).toBe(50)

        // After reset, the dimensions match natural, so the button
        // should disable itself. canReset gates this; if the gate ever
        // started always returning true, a second click would still
        // commit (a no-op but a wasted Yjs transaction).
        await expect(resetButton).toBeDisabled()
    })
})
