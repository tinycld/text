import { expect, test } from '@playwright/test'
import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from '../../tinycld/tests/e2e/helpers'
import {
    editorRoot,
    FEATURE_DOC_HEADING,
    uniqueDocName,
    uploadDocxAsDriveItem,
    waitForEditor,
} from './_menubar-helpers'
import {
    createSecondUser,
    loginAs,
    readClientAuthors,
    shareDriveItemWith,
} from './helpers/seed-multi-user'

// E2E coverage for Phase 3a server-side authorship stamping. Two
// distinct browser contexts (alice + bob) each instantiate their own
// Y.Doc with a distinct clientID, share the same text document, and
// each types a character. The server's broker hook stamps the
// `clientAuthors` Y.Map with each clientID → user_id pair as the
// writes flow through; after both round-trips converge, the live
// Y.Doc on alice's tab must surface entries for both clientIDs.
//
// The client is intentionally oblivious to stamping: there is no UI
// for it in this phase. The spec page-evaluates the Y.Doc through a
// dev-only window hook (window.__tinyTextDoc) exposed by the screen
// at mount; the hook is gated on Metro's __DEV__ so production
// bundles ship without it.

test.describe('Text — Authorship stamping', () => {
    test('clientAuthors is populated for two distinct collaborators', async ({ browser }) => {
        // Two browser contexts = two distinct sessions; each Yjs.Doc
        // mints a separate clientID, so the server should stamp two
        // distinct entries (one per writer) into the clientAuthors map.
        const itemId = await uploadDocxAsDriveItem(uniqueDocName('authorship-stamping'))
        const userB = await createSecondUser('authorship-stamping')
        await shareDriveItemWith(itemId, userB)

        const aliceContext = await browser.newContext()
        const bobContext = await browser.newContext()
        try {
            const alicePage = await aliceContext.newPage()
            const bobPage = await bobContext.newPage()

            await loginAs(alicePage, TEST_USER_EMAIL, TEST_USER_PASSWORD)
            await alicePage.goto(`/a/text/${itemId}`)
            await waitForEditor(alicePage)
            await expect(alicePage.getByText(FEATURE_DOC_HEADING).first()).toBeVisible()

            await loginAs(bobPage, userB.email, userB.password)
            await bobPage.goto(`/a/text/${itemId}`)
            await waitForEditor(bobPage)
            await expect(bobPage.getByText(FEATURE_DOC_HEADING).first()).toBeVisible()

            // Each context types a unique marker. Each keystroke flows
            // alice/bob → broker → stamper (mutates clientAuthors map)
            // → fan-out → both tabs converge. The markers are unique
            // both for human debuggability and to make sure the
            // assertion below can pin "alice typed and the text landed
            // locally" before we check cross-user replication.
            const aliceMarker = `alice-${Date.now()}`
            // Click in the body of the editor and then use ⌘/Ctrl+End
            // to drop the caret at the very end of the doc. Clicking
            // on the editor surface lands the caret somewhere; the
            // explicit end-key shift positions it at the end so the
            // marker doesn't collide with the seeded fixture text.
            const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
            await editorRoot(alicePage).click()
            await alicePage.keyboard.press(`${meta}+End`)
            await alicePage.keyboard.press('Enter')
            await alicePage.keyboard.type(aliceMarker, { delay: 20 })
            // First pin the marker locally — proves the keystroke
            // actually landed in alice's editor before we wait on
            // cross-user fan-out.
            await expect(alicePage.getByText(aliceMarker)).toBeVisible()
            await expect(bobPage.getByText(aliceMarker)).toBeVisible()

            const bobMarker = `bob-${Date.now()}`
            await editorRoot(bobPage).click()
            await bobPage.keyboard.press(`${meta}+End`)
            await bobPage.keyboard.press('Enter')
            await bobPage.keyboard.type(bobMarker, { delay: 20 })
            await expect(bobPage.getByText(bobMarker)).toBeVisible()
            await expect(alicePage.getByText(bobMarker)).toBeVisible()

            // Inspect the live Y.Doc on alice's page. The screen
            // exposes window.__tinyTextDoc as a dev-only hook (see
            // useDevYDocWindowHook in screens/[id].tsx). At this
            // point each side has both typed and received the other's
            // marker, so the broker's stamper has stamped both
            // clientIDs into the clientAuthors map and the fan-out has
            // landed on alice. Poll briefly to absorb the lag between
            // the visible-marker round-trip and the stamping delta's
            // re-publication.
            await expect
                .poll(async () => (await readClientAuthors(alicePage)).length)
                .toBeGreaterThanOrEqual(2)
            const entries = await readClientAuthors(alicePage)
            for (const [, userID] of entries) {
                // user IDs are PocketBase 15-char lowercase
                // alphanumerics; the laxer regex below tolerates any
                // length of that alphabet to stay robust against an
                // ID-format change while still pinning "this is not
                // empty and not whitespace".
                expect(userID).toMatch(/^[a-z0-9]+$/)
                expect(userID.length).toBeGreaterThan(0)
            }

            // The two stamped user IDs must be distinct — one per
            // writer. (If they collide, either the stamper used the
            // wrong identity for one side, or the test's two contexts
            // somehow ended up authenticated as the same membership.)
            const distinctUserIDs = new Set(entries.map(([, uid]) => uid))
            expect(distinctUserIDs.size).toBeGreaterThanOrEqual(2)
        } finally {
            await aliceContext.close()
            await bobContext.close()
        }
    })
})
