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

// End-to-end contract for the viewer role on a doc with pending
// suggestions. Alice (owner / editor) makes a suggestion; Bob
// (viewer) loads the doc and sees the suggestion's underlying TEXT
// (the schema mark still ships so Yjs decode is safe) but DOES NOT
// see the suggestion's visual affordances: no colored decoration, no
// review drawer toggle, no per-row Accept/Reject buttons, no bulk
// resolve buttons.
//
// This is the "read-only design decision" — viewers see content but
// no comments/suggestions surfaces. See screens/[id].tsx for the
// decision comment and authorship_stamper.go for the server-side
// audience gate that mirrors it.
//
// Pins the contract layer by layer:
//   - schema mark renders (data-suggested-insert) so the text is
//     present in the DOM — Yjs parity is preserved
//   - decoration plugin is OMITTED on read-only mounts, so the
//     `.tinycld-suggestion-insert` colored span is absent
//   - review drawer, bulk buttons, and per-row Accept/Reject are
//     unmounted entirely

test.describe('Text — Viewer cannot resolve', () => {
    test('alice suggests → bob (viewer) sees row but cannot resolve', async ({ browser }) => {
        // Two contexts: Alice the owner/editor, Bob the freshly-minted
        // viewer. Bob's drive_shares role is 'viewer' (not 'editor'),
        // which is the difference from two-user-suggestion-flow.

        const itemId = await uploadDocxAsDriveItem(uniqueDocName('viewer-cannot-resolve'))
        const bob = await createSecondUser('viewer-resolve')
        await shareDriveItemWith(itemId, bob, 'viewer')

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

            // Alice switches to Suggesting mode and types a marker.
            await alicePage.getByRole('button', { name: 'Editor mode' }).click()
            await alicePage.getByRole('menuitem', { name: 'Suggesting' }).click()
            await expect(alicePage.locator('[data-current-mode="suggesting"]')).toBeVisible()

            const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
            await editorRoot(alicePage).click()
            await alicePage.keyboard.press(`${meta}+End`)
            await alicePage.keyboard.press('Enter')
            const marker = `alice suggests ${Date.now()}`
            await alicePage.keyboard.type(marker, { delay: 25 })

            // Alice's tab carries the suggestedInsert decoration.
            await expect(alicePage.locator('[data-suggested-insert]').first()).toBeVisible()

            // Bob's tab still has the SCHEMA mark in the DOM so the
            // underlying text replicates via Yjs (data-suggested-insert
            // is the schema's renderHTML output; without it y-prosemirror
            // would drop the mark on parse). The marker text is visible.
            await expect(bobPage.locator('[data-suggested-insert]').first()).toBeVisible()
            await expect(bobPage.getByText(marker)).toBeVisible()

            // The DECORATION span — the colored tint + underline that
            // the SuggestionDecorations plugin emits — is absent. Read-
            // only viewer mounts omit the decoration plugin entirely
            // (see buildSuggestionEditorExtensions's readOnly flag).
            // Asserting toHaveCount(0) at page scope confirms no
            // .tinycld-suggestion-insert span exists anywhere.
            await expect(bobPage.locator('.tinycld-suggestion-insert')).toHaveCount(0)

            // Collaboration cursors are a writer-side affordance — the
            // CollaborationCaret extension is omitted from viewer
            // mounts (see use-document-editor.web.tsx's isReadOnly
            // branch). No floating caret labels OR remote selections
            // surface for Bob, even though Alice is actively typing.
            await expect(bobPage.locator('.collaboration-carets__caret')).toHaveCount(0)
            await expect(bobPage.locator('.ProseMirror-yjs-selection')).toHaveCount(0)

            // The drawer-open toolbar button itself is omitted entirely
            // for viewers — screens/[id].tsx gates the
            // OpenCommentsDrawerButton + DocumentToolbar's review-drawer
            // trigger on showCollaborativeAffordances. (Previously this
            // button was rendered but disabled; now it's not rendered.)
            await expect(
                bobPage.getByRole('button', { name: 'Open suggestion review drawer' })
            ).toHaveCount(0)

            // CRITICAL: the per-row Accept / Reject buttons (rendered
            // inside the drawer, gated on canResolve in
            // SuggestionRow.tsx:124-151) are not on Bob's page. Since
            // the drawer itself is closed AND the toolbar button is
            // disabled, Bob has no path to the buttons. Asserting
            // toHaveCount(0) at page scope pins both layers — the
            // drawer-gating layer and the canResolve gating layer —
            // simultaneously: a regression in either would surface a
            // button in the page DOM.
            await expect(bobPage.getByRole('button', { name: 'Accept suggestion' })).toHaveCount(0)
            await expect(bobPage.getByRole('button', { name: 'Reject suggestion' })).toHaveCount(0)

            // Same logic for the drawer's bulk affordances — gated by
            // ReviewDrawer.tsx:177 on canResolve, and unreachable for
            // Bob anyway because the drawer can't be opened.
            await expect(
                bobPage.getByRole('button', { name: 'Accept all suggestions' })
            ).toHaveCount(0)
            await expect(
                bobPage.getByRole('button', { name: 'Reject all suggestions' })
            ).toHaveCount(0)
        } finally {
            await aliceContext.close()
            await bobContext.close()
        }
    })
})
