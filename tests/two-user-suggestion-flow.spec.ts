import { expect, test } from '@playwright/test'
import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from '../../tinycld/tests/e2e/helpers'
import {
    editorRoot,
    FEATURE_DOC_HEADING,
    uniqueDocName,
    uploadDocxAsDriveItem,
    waitForEditor,
} from './_menubar-helpers'
import { createSecondUser, loginAs, shareDriveItemWith } from './helpers/seed-multi-user'

// Two-user end-to-end flow for suggestion replication and remote
// resolution. Alice (the doc owner) shares as editor with Bob (a
// freshly-minted user), Alice switches to Suggesting and types
// a phrase, Bob's tab sees the suggestedInsert decoration replicate
// over Yjs realtime, Bob opens the review drawer (in Editing mode
// to avoid the command layer re-stamping Accept), clicks Accept,
// and Alice's tab sees the mark vanish + the text remain as a
// regular run.
//
// This pins the cross-user contract end users feel: suggestions
// propagate live to collaborators, Accept lands on every tab, and
// the resolved text persists across the round-trip. Single-context
// resolution is covered by suggesting-mode-flow.spec.ts; this spec
// adds the cross-tab dimension.

test.describe('Text — Two-user suggestion flow', () => {
    test('alice suggests insert → bob accepts → alice sees mark gone', async ({ browser }) => {
        // Two browser contexts simulate two collaborators on the same
        // doc. Each context boots its own realtime room + Yjs Doc; we
        // wait on realtime replication between them, so the budget needs
        // headroom over the default. Same envelope the comments
        // concurrent-tabs spec uses.

        const itemId = await uploadDocxAsDriveItem(uniqueDocName('two-user-suggestion'))
        const bob = await createSecondUser('two-user-suggestion')
        await shareDriveItemWith(itemId, bob)

        const aliceContext = await browser.newContext()
        const bobContext = await browser.newContext()
        try {
            const alicePage = await aliceContext.newPage()
            const bobPage = await bobContext.newPage()

            await loginAs(alicePage, TEST_USER_EMAIL, TEST_USER_PASSWORD)
            await alicePage.goto(`/text/${itemId}`)
            await waitForEditor(alicePage)
            await expect(alicePage.getByText(FEATURE_DOC_HEADING).first()).toBeVisible()

            await loginAs(bobPage, bob.email, bob.password)
            await bobPage.goto(`/text/${itemId}`)
            await waitForEditor(bobPage)
            await expect(bobPage.getByText(FEATURE_DOC_HEADING).first()).toBeVisible()

            // Alice switches to Suggesting mode via the toolbar dropdown.
            await alicePage.getByRole('button', { name: 'Editor mode' }).click()
            await alicePage.getByRole('menuitem', { name: 'Suggesting' }).click()
            await expect(alicePage.locator('[data-current-mode="suggesting"]')).toBeVisible()

            // Alice types a marker phrase. In Suggesting mode the
            // command layer rewrites each insert step into addMark
            // ('suggestedInsert') — the text lands on Alice's tab
            // carrying the mark AND y-prosemirror serializes the Yjs
            // mark for the realtime broker to fan out.
            await editorRoot(alicePage).click()
            const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
            await alicePage.keyboard.press(`${meta}+End`)
            await alicePage.keyboard.press('Enter')
            const marker = `alice suggests this ${Date.now()}`
            await alicePage.keyboard.type(marker, { delay: 25 })

            // Alice sees the suggestedInsert decoration on her tab
            // first — local PM transaction landed.
            await expect(alicePage.locator('[data-suggested-insert]').first()).toBeVisible()
            // Bob's tab sees the same span after realtime replication.
            // The broker fans out the Yjs delta; y-prosemirror on Bob
            // applies it and the schema's renderHTML emits
            // data-suggested-insert just like on Alice's side.
            await expect(bobPage.locator('[data-suggested-insert]').first()).toBeVisible()
            await expect(bobPage.getByText(marker)).toBeVisible()

            // Bob opens the review drawer.
            await bobPage.getByRole('button', { name: 'Open suggestion review drawer' }).click()
            await expect(bobPage.getByText('Suggestions').first()).toBeVisible()

            // The drawer's SuggestionRow renders Alice's user id
            // as the authorId via accessibilityLabel "Suggestion by
            // <authorId>". Bob may be in Editing or Viewing by
            // default (he hasn't touched the menu); both keep the
            // Accept button available because his drive_share role is
            // editor (canResolve=true).
            await expect(
                bobPage.getByRole('button', { name: /^Suggestion by /i }).first()
            ).toBeVisible()

            // Bob clicks Accept all. Bob is in Editing mode by
            // default (the menu defaults to Editing on first mount
            // and Bob never switched), so the resolver's
            // tr.removeMark step lands directly without command-layer
            // re-interception.
            await bobPage.getByRole('button', { name: 'Accept all suggestions' }).click()

            // Bob's tab: the suggestedInsert mark is gone from the
            // doc — the schema's data-suggested-insert attribute
            // disappears once the resolver's removeMark step lands.
            // (The Y.Map entry persists but the bridge surfaces it
            // as an Orphaned row, separate from the Open list.)
            await expect(bobPage.locator('[data-suggested-insert]')).toHaveCount(0)

            // Alice's tab: the suggestedInsert decoration is gone
            // after the Yjs delta replicates. The broker fans Bob's
            // resolver transaction out; y-prosemirror on Alice
            // applies it and the schema strips the attribute.
            await expect(alicePage.locator('[data-suggested-insert]')).toHaveCount(0)
            // The underlying text Alice typed is still in the doc as
            // a regular paragraph run — Accept never removes content,
            // it only strips the suggestion wrapper.
            await expect(alicePage.getByText(marker)).toBeVisible()
        } finally {
            await aliceContext.close()
            await bobContext.close()
        }
    })
})
