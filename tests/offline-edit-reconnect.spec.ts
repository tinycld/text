import { expect, test } from '@playwright/test'
import { login, realtimeOutage } from '../../tinycld/tests/e2e/helpers'
import {
    editorRoot,
    FEATURE_DOC_HEADING,
    uniqueDocName,
    uploadDocxAsDriveItem,
    waitForEditor,
} from './_menubar-helpers'

// A solo editor's connection drops: the server sees the room empty and, since
// nobody else is in it, used to close the document and rebuild it from the
// docx at the next join. What the editor typed while disconnected then either
// vanished (a client that discards its state on a rebuilt document) or showed
// up twice (one that merges into it). The broker now PARKS the document, so
// the reconnect lands on the same one and the client's edits apply.
test.describe('Text — edits typed during an outage', () => {
    test('reach the document once the connection is back, exactly once', async ({ page }) => {
        const itemId = await uploadDocxAsDriveItem(uniqueDocName('outage'))
        const outage = await realtimeOutage(page)

        await login(page)
        await page.goto(`/a/text/${itemId}`)
        await waitForEditor(page)
        await expect(page.getByText(FEATURE_DOC_HEADING).first()).toBeVisible()

        await outage.begin()
        // The indicator proves the socket really dropped; without it the test
        // would be typing into a connected editor and prove nothing.
        await expect(page.getByText('Reconnecting…')).toBeVisible({ timeout: 10_000 })

        const marker = `outage-marker-${Date.now()}`
        await editorRoot(page).click()
        await page.keyboard.press('ControlOrMeta+End')
        await page.keyboard.press('Enter')
        await page.keyboard.type(marker)

        await outage.end()
        await expect(page.getByText('Reconnecting…')).toBeHidden({ timeout: 20_000 })

        // Past the save debounce, so the reload reads what the server wrote.
        await page.waitForTimeout(6_000)
        await page.reload()
        await waitForEditor(page)
        await expect(page.getByText(marker)).toHaveCount(1)
        // The body mentions the title too; the H1 is what a merged second
        // incarnation would duplicate.
        await expect(
            page.getByRole('heading', { level: 1, name: FEATURE_DOC_HEADING })
        ).toHaveCount(1)
    })
})
