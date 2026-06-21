import { expect, type Page, test } from '@playwright/test'
import { ORG_SLUG, TEST_USER_EMAIL, TEST_USER_PASSWORD } from '../../tinycld/tests/e2e/helpers'
import {
    editorRoot,
    FEATURE_DOC_HEADING,
    PB_URL,
    uniqueDocName,
    uploadDocxAsDriveItem,
    waitForEditor,
} from './_menubar-helpers'

// E2E coverage for Phase 3a server-side authorship stamping. Two
// distinct browser contexts (alice + bob) each instantiate their own
// Y.Doc with a distinct clientID, share the same text document, and
// each types a character. The server's broker hook stamps the
// `clientAuthors` Y.Map with each clientID → user_org_id pair as the
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
        const userB = await createSecondUser()
        await shareDriveItemWith(itemId, userB)

        const aliceContext = await browser.newContext()
        const bobContext = await browser.newContext()
        try {
            const alicePage = await aliceContext.newPage()
            const bobPage = await bobContext.newPage()

            await loginAs(alicePage, TEST_USER_EMAIL, TEST_USER_PASSWORD)
            await alicePage.goto(`/a/${ORG_SLUG}/text/${itemId}`)
            await waitForEditor(alicePage)
            await expect(alicePage.getByText(FEATURE_DOC_HEADING).first()).toBeVisible()

            await loginAs(bobPage, userB.email, userB.password)
            await bobPage.goto(`/a/${ORG_SLUG}/text/${itemId}`)
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
            for (const [, userOrgID] of entries) {
                // user_org IDs are PocketBase 15-char lowercase
                // alphanumerics; the laxer regex below tolerates any
                // length of that alphabet to stay robust against an
                // ID-format change while still pinning "this is not
                // empty and not whitespace".
                expect(userOrgID).toMatch(/^[a-z0-9]+$/)
                expect(userOrgID.length).toBeGreaterThan(0)
            }

            // The two stamped user_org IDs must be distinct — one per
            // writer. (If they collide, either the stamper used the
            // wrong identity for one side, or the test's two contexts
            // somehow ended up authenticated as the same membership.)
            const distinctUserOrgIDs = new Set(entries.map(([, uo]) => uo))
            expect(distinctUserOrgIDs.size).toBeGreaterThanOrEqual(2)
        } finally {
            await aliceContext.close()
            await bobContext.close()
        }
    })
})

// readClientAuthors evaluates the live Y.Doc on `page` and returns the
// flattened clientAuthors map entries. Callers wrap this in expect.poll to
// wait for the stamping delta's re-publication via the broker to land.
async function readClientAuthors(page: Page): Promise<[string, string][]> {
    return page.evaluate(() => {
        const w = window as unknown as {
            __tinyTextDoc?: {
                getMap: (n: string) => {
                    forEach: (cb: (v: unknown, k: string) => void) => void
                }
            }
        }
        const doc = w.__tinyTextDoc
        if (!doc) return [] as [string, string][]
        const m = doc.getMap('clientAuthors')
        const out: [string, string][] = []
        m.forEach((v: unknown, k: string) => {
            if (typeof v === 'string') out.push([k, v])
        })
        return out
    })
}

interface SecondUser {
    id: string
    email: string
    password: string
    userOrgId: string
}

// Mint a fresh user via the superuser API and add them to test-org.
// Mirrors the helper in text-document.spec.ts / comments.spec.ts
// inline here so this spec stays self-contained (matching the existing
// pattern in this directory until a shared helpers module is carved out).
async function createSecondUser(): Promise<SecondUser> {
    const adminEmail = process.env.ADMIN_USER_LOGIN ?? 'admin@tinycld.org'
    const adminPassword = process.env.ADMIN_USER_PW ?? 'AdminPass1234!'

    const adminAuth = await fetch(`${PB_URL}/api/collections/_superusers/auth-with-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity: adminEmail, password: adminPassword }),
    })
    if (!adminAuth.ok) {
        throw new Error(`Superuser auth failed: ${adminAuth.status} ${await adminAuth.text()}`)
    }
    const { token: adminToken } = (await adminAuth.json()) as { token: string }

    const orgsRes = await fetch(
        `${PB_URL}/api/collections/orgs/records?filter=${encodeURIComponent(`slug='${ORG_SLUG}'`)}`,
        { headers: { Authorization: adminToken } }
    )
    const orgs = (await orgsRes.json()) as { items: { id: string }[] }
    if (!orgs.items[0]) throw new Error(`Org ${ORG_SLUG} not found`)
    const orgId = orgs.items[0].id

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const email = `authorship-test-${suffix}@tinycld.org`
    const password = 'AuthorshipTest1234!'

    const userRes = await fetch(`${PB_URL}/api/collections/users/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: adminToken },
        body: JSON.stringify({
            email,
            password,
            passwordConfirm: password,
            name: `Authorship Tester ${suffix}`,
            username: `auth_${suffix.replace(/-/g, '_')}`,
            verified: true,
        }),
    })
    if (!userRes.ok) {
        throw new Error(`Create user failed: ${userRes.status} ${await userRes.text()}`)
    }
    const user = (await userRes.json()) as { id: string }

    const userOrgRes = await fetch(`${PB_URL}/api/collections/user_org/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: adminToken },
        body: JSON.stringify({ user: user.id, org: orgId, role: 'member' }),
    })
    if (!userOrgRes.ok) {
        throw new Error(`Create user_org failed: ${userOrgRes.status} ${await userOrgRes.text()}`)
    }
    const userOrg = (await userOrgRes.json()) as { id: string }

    return { id: user.id, email, password, userOrgId: userOrg.id }
}

async function shareDriveItemWith(itemId: string, user: SecondUser): Promise<void> {
    const adminEmail = process.env.ADMIN_USER_LOGIN ?? 'admin@tinycld.org'
    const adminPassword = process.env.ADMIN_USER_PW ?? 'AdminPass1234!'
    const adminAuth = await fetch(`${PB_URL}/api/collections/_superusers/auth-with-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity: adminEmail, password: adminPassword }),
    })
    const { token: adminToken } = (await adminAuth.json()) as { token: string }

    const res = await fetch(`${PB_URL}/api/collections/drive_shares/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: adminToken },
        body: JSON.stringify({
            item: itemId,
            user_org: user.userOrgId,
            role: 'editor',
            created_by: user.userOrgId,
        }),
    })
    if (!res.ok) {
        throw new Error(`Share drive_item failed: ${res.status} ${await res.text()}`)
    }
}

async function loginAs(page: Page, identifier: string, password: string): Promise<void> {
    await page.goto('/')
    await page.getByTestId('identifier').fill(identifier)
    await page.getByPlaceholder('Password').fill(password)
    await page.getByText('Sign in', { exact: true }).last().click()
    await page.waitForURL(/\/a\//)
}
