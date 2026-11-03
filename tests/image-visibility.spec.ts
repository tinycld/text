import { expect, type Locator, type Page, test } from '@playwright/test'
import { createShareLink } from '../../drive/tests/helpers'
import { TEST_USER_PASSWORD, TEST_USER_USERNAME } from '../../tinycld/tests/e2e/helpers'
import {
    editorRoot,
    FEATURE_DOC_HEADING,
    uniqueDocName,
    uploadDocxAsDriveItem,
    waitForEditor,
} from './_menubar-helpers'
import { createSecondUser, loginAs, shareDriveItemWith } from './helpers/seed-multi-user'

// An image inserted into a document is its own drive_items row in the
// inserter's Drive, and every drive file is served behind the row's view
// rule. The upload attaches the image to the document (attached_to), so
// whoever can view the document can load the image: a collaborator through
// the document's share, an anonymous visitor through the share session.

// 24×48 RGBA PNG; Chromium decodes it, so naturalWidth proves the load.
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABgAAAAwCAYAAAALiLqjAAAAMElEQVR4nO3NIQ0AAAgAMIIRjIi0ghQItovrR1fOpRAIBAKBQCAQCAQCgUAgEHwKFnzKKiYoX5M4AAAAAElFTkSuQmCC',
    'base64'
)

function driveImage(page: Page): Locator {
    return editorRoot(page).locator('img').first()
}

async function expectLoaded(image: Locator) {
    await expect(image).toBeVisible()
    await expect
        .poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
        .toBe(true)
}

async function insertImageAsOwner(page: Page, itemId: string) {
    await loginAs(page, TEST_USER_USERNAME, TEST_USER_PASSWORD)
    await page.goto(`/a/text/${itemId}`)
    await waitForEditor(page)
    await expect(editorRoot(page).getByText(FEATURE_DOC_HEADING).first()).toBeVisible()
    await editorRoot(page).click()
    await page.keyboard.press('End')
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Insert image', exact: true }).click()
    await (await chooser).setFiles({ name: 'shared-image.png', mimeType: 'image/png', buffer: PNG })
    await expectLoaded(driveImage(page))
}

test.describe('Text — inserted images reach the document viewers', () => {
    test('a collaborator the document is shared with sees the image', async ({ browser }) => {
        const itemId = await uploadDocxAsDriveItem(uniqueDocName('image-collab'))
        const bob = await createSecondUser('image-collab')
        await shareDriveItemWith(itemId, bob, 'viewer')

        const owner = await browser.newContext()
        const viewer = await browser.newContext()
        try {
            await insertImageAsOwner(await owner.newPage(), itemId)

            const bobPage = await viewer.newPage()
            await loginAs(bobPage, bob.username, bob.password)
            await bobPage.goto(`/a/text/${itemId}`)
            await waitForEditor(bobPage)
            await expectLoaded(driveImage(bobPage))
        } finally {
            await owner.close()
            await viewer.close()
        }
    })

    test('an anonymous share-link visitor sees the image', async ({ browser }) => {
        const itemId = await uploadDocxAsDriveItem(uniqueDocName('image-anon'))
        const owner = await browser.newContext()
        const visitor = await browser.newContext()
        try {
            await insertImageAsOwner(await owner.newPage(), itemId)
            const link = await createShareLink({ itemId, role: 'viewer' })

            const anon = await visitor.newPage()
            await anon.goto(`/p/drive/share/${link.token}`)
            await waitForEditor(anon)
            await expectLoaded(driveImage(anon))
        } finally {
            await owner.close()
            await visitor.close()
        }
    })
})
