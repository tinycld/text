import { expect, test } from '@playwright/test'
import { login } from '../../tinycld/tests/e2e/helpers'
import { editorRoot, uploadRtfAsDriveItem, waitForEditor } from './_menubar-helpers'

test.describe('Text — RTF round-trip', () => {
    test('opening an RTF drive item loads its content in the editor', async ({ page }) => {
        const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
        const itemId = await uploadRtfAsDriveItem(`RtfOpen-${stamp}.rtf`)

        await login(page)
        // Initial doc load is the one allowed goto (SPA is torn down on nav).
        await page.goto(`/text/${itemId}`)
        await waitForEditor(page)

        // The fixture's heading + a unique searchable token must render —
        // proof the RTF was bridged to docx and walked into ProseMirror on
        // the server bootstrap.
        await expect(editorRoot(page).getByText('RTF Sample Heading').first()).toBeVisible()
        await expect(
            editorRoot(page)
                .getByText(/pineapple-quokka-4271/)
                .first()
        ).toBeVisible()
    })
})
