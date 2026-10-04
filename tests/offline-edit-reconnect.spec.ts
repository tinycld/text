import { expect, test } from '@playwright/test'
import { login, realtimeOutage } from '../../tinycld/tests/e2e/helpers'
import {
    editorRoot,
    FEATURE_DOC_HEADING,
    uniqueDocName,
    uploadDocxAsDriveItem,
    waitForEditor,
} from './_menubar-helpers'
import { readClientAuthors } from './helpers/seed-multi-user'

// A solo editor's connection drops: the server sees the room empty and used
// to close the document and rebuild it from the docx at the next join. A
// rebuilt document is a new incarnation: the authorship the server stamped
// (clientAuthors, kept only in the Yjs state) is gone, every item has a new
// identity, and a returning client has to throw its own copy away. The broker
// now PARKS the document, so the reconnect lands on the same one: the edit
// typed during the outage applies, and the stamp made before it survives.
test.describe('Text — a connection outage', () => {
    test('keeps the document: the outage edit applies and the earlier author stamp survives', async ({
        page,
    }) => {
        const itemId = await uploadDocxAsDriveItem(uniqueDocName('outage'))
        const outage = await realtimeOutage(page)

        await login(page)
        await page.goto(`/a/text/${itemId}`)
        await waitForEditor(page)
        await expect(page.getByText(FEATURE_DOC_HEADING).first()).toBeVisible()

        // Type while connected, so the server stamps this client's Yjs id as
        // an author. That stamp lives only in the Yjs state: a document
        // rebuilt from the docx does not have it.
        const onlineMarker = `online-marker-${Date.now()}`
        await editorRoot(page).click()
        await page.keyboard.press('ControlOrMeta+End')
        await page.keyboard.press('Enter')
        await page.keyboard.type(onlineMarker)
        await expect
            .poll(async () => (await readClientAuthors(page)).length)
            .toBeGreaterThanOrEqual(1)
        const stampedIDs = (await readClientAuthors(page)).map(([clientID]) => clientID)
        // Past the save debounce: the docx now holds the online text, so a
        // rebuild would show it and only the stamp would tell the two apart.
        await page.waitForTimeout(6_000)

        await outage.begin()
        // The indicator proves the socket really dropped; without it the test
        // would be typing into a connected editor and prove nothing.
        await expect(page.getByText('Reconnecting…')).toBeVisible({ timeout: 10_000 })

        const outageMarker = `outage-marker-${Date.now()}`
        await editorRoot(page).click()
        await page.keyboard.press('ControlOrMeta+End')
        await page.keyboard.press('Enter')
        await page.keyboard.type(outageMarker)

        await outage.end()
        await expect(page.getByText('Reconnecting…')).toBeHidden({ timeout: 20_000 })

        // Past the save debounce, then a fresh client reads what the server
        // holds rather than what this editor remembers.
        await page.waitForTimeout(6_000)
        await page.reload()
        await waitForEditor(page)
        await expect(page.getByText(outageMarker)).toHaveCount(1)
        await expect(page.getByText(onlineMarker)).toHaveCount(1)
        // The body mentions the title too; the H1 is what a merged second
        // incarnation would duplicate.
        await expect(
            page.getByRole('heading', { level: 1, name: FEATURE_DOC_HEADING })
        ).toHaveCount(1)
        await expect
            .poll(async () => (await readClientAuthors(page)).map(([clientID]) => clientID))
            .toEqual(expect.arrayContaining(stampedIDs))
    })
})
