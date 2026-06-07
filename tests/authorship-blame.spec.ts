import { expect, type Page, test } from '@playwright/test'
import { ORG_SLUG, TEST_USER_EMAIL, TEST_USER_PASSWORD } from '../../tinycld/tests/e2e/helpers'
import {
    EDITOR_READY_TIMEOUT,
    editorRoot,
    FEATURE_DOC_HEADING,
    PB_URL,
    TEXT_TEST_TIMEOUT,
    uniqueDocName,
    uploadDocxAsDriveItem,
    waitForEditor,
} from './_menubar-helpers'

// End-to-end flow for paragraph-scoped authorship "blame":
// Alice + Bob each type into distinct paragraphs, the doc's
// clientAuthors Y.Map collects both clientIDs → user_org_ids, the
// Authorship tab surfaces per-contributor percentages, and a
// right-click on a paragraph opens a popover scoped to that
// paragraph's authors.
//
// The authorship surface ships in two places:
//   1. ReviewDrawer's Authorship tab (per-doc summary) — the
//      "Color text by author" toggle + ContributorBar list.
//   2. AuthorshipPopover (per-paragraph blame) — opens on
//      contextmenu over the editor surface; rendered into the screen
//      with data-testid="authorship-popover".
//
// Both are derivable from the live yDoc's clientAuthors map + the
// editor's Y.XmlFragment; the spec assembles two writers and walks
// each surface.

test.describe('Text — Authorship blame', () => {
    test.setTimeout(TEXT_TEST_TIMEOUT)

    test('two writers → authorship tab + paragraph popover', async ({ browser }) => {
        // Two contexts = two Y.Doc clientIDs. We need both writers'
        // edits to converge on Alice's tab so the popover and
        // contributor list see both authors.
        test.setTimeout(180_000)

        const itemId = await uploadDocxAsDriveItem(uniqueDocName('authorship-blame'))
        const bob = await createSecondUser()
        await shareDriveItemWith(itemId, bob)

        const aliceContext = await browser.newContext()
        const bobContext = await browser.newContext()
        try {
            const alicePage = await aliceContext.newPage()
            const bobPage = await bobContext.newPage()

            await loginAs(alicePage, TEST_USER_EMAIL, TEST_USER_PASSWORD)
            await alicePage.goto(`/a/${ORG_SLUG}/text/${itemId}`)
            await waitForEditor(alicePage)
            await expect(alicePage.getByText(FEATURE_DOC_HEADING).first()).toBeVisible({
                timeout: EDITOR_READY_TIMEOUT,
            })

            await loginAs(bobPage, bob.email, bob.password)
            await bobPage.goto(`/a/${ORG_SLUG}/text/${itemId}`)
            await waitForEditor(bobPage)
            await expect(bobPage.getByText(FEATURE_DOC_HEADING).first()).toBeVisible({
                timeout: EDITOR_READY_TIMEOUT,
            })

            // Alice and Bob each type into their own paragraph. The
            // contextmenu handler resolves a click to the top-level
            // block index and reads that block's per-author runs, so
            // we need each marker in its own paragraph for the
            // assertion below to scope to a single author.
            const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
            const aliceMarker = `alice unique ${Date.now()}`
            await editorRoot(alicePage).click()
            await alicePage.keyboard.press(`${meta}+End`)
            await alicePage.keyboard.press('Enter')
            await alicePage.keyboard.type(aliceMarker, { delay: 20 })
            await expect(alicePage.getByText(aliceMarker)).toBeVisible({ timeout: 10_000 })
            await expect(bobPage.getByText(aliceMarker)).toBeVisible({ timeout: 15_000 })

            const bobMarker = `bob unique ${Date.now()}`
            await editorRoot(bobPage).click()
            await bobPage.keyboard.press(`${meta}+End`)
            await bobPage.keyboard.press('Enter')
            await bobPage.keyboard.type(bobMarker, { delay: 20 })
            await expect(bobPage.getByText(bobMarker)).toBeVisible({ timeout: 10_000 })
            await expect(alicePage.getByText(bobMarker)).toBeVisible({ timeout: 15_000 })

            // Wait for clientAuthors to populate with 2+ entries on
            // Alice's tab. The stamper writes one entry per writing
            // clientID; once both Alice and Bob have typed and the
            // delta has fanned out, Alice should see both.
            const entries = await pollClientAuthors(alicePage, 2, 15_000)
            expect(entries.length).toBeGreaterThanOrEqual(2)

            // Open Alice's review drawer.
            await alicePage.getByRole('button', { name: 'Open suggestion review drawer' }).click()
            await expect(alicePage.getByText('Suggestions').first()).toBeVisible({
                timeout: 5_000,
            })

            // Switch to the Authorship tab.
            await alicePage.getByRole('tab', { name: 'Authorship' }).click()

            // The Switch's accessibilityLabel is "Color text by author"
            // and lives at the top of the tab. Its presence pins that
            // we're on the right tab.
            await expect(alicePage.getByLabel('Color text by author')).toBeVisible({
                timeout: 5_000,
            })

            // At least one contributor row renders a percentage label
            // of the form "<N>%". Use .first() because there are two
            // — one per author — and we only need to pin that the
            // aggregation produced output.
            await expect(alicePage.getByText(/^\d+%$/).first()).toBeVisible({ timeout: 10_000 })

            // Right-click on Alice's paragraph containing Bob's
            // marker. The contextmenu handler resolves the clicked
            // block to its Y.XmlText and surfaces Bob as a
            // contributor for that paragraph. We click on Bob's text
            // because that's the unambiguous case — Alice never typed
            // into that paragraph, so the popover's per-paragraph
            // attribution must include Bob.
            //
            // The locator finds the <p> wrapper for Bob's marker;
            // click({button: 'right'}) fires a contextmenu event with
            // the marker as target.
            await alicePage.locator(`p:has-text("${bobMarker}")`).click({ button: 'right' })

            const popover = alicePage.locator('[data-testid="authorship-popover"]')
            await expect(popover).toBeVisible({ timeout: 5_000 })

            // The popover lists contributors with their percentages.
            // We can't easily map user_org_id to a display name in the
            // test, but the popover's ContributorRow renders the
            // percentage in the form "(N%)" — assert at least one
            // such cell exists inside the popover scope.
            await expect(popover.getByText(/\(\d+%\)/).first()).toBeVisible({ timeout: 5_000 })
        } finally {
            await aliceContext.close()
            await bobContext.close()
        }
    })
})

// pollClientAuthors evaluates the live Y.Doc on `page` and returns the
// flattened clientAuthors map entries. Polls until the map has at
// least `minEntries` keys or `timeoutMs` elapses. Mirrors the helper
// inlined in authorship-stamping.spec.ts.
async function pollClientAuthors(
    page: Page,
    minEntries: number,
    timeoutMs: number
): Promise<[string, string][]> {
    const deadline = Date.now() + timeoutMs
    let entries: [string, string][] = []
    while (Date.now() < deadline) {
        entries = await page.evaluate(() => {
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
        if (entries.length >= minEntries) return entries
        await new Promise(r => setTimeout(r, 200))
    }
    return entries
}

interface SecondUser {
    id: string
    email: string
    password: string
    userOrgId: string
}

// Mint a fresh user via the superuser API and add them to test-org.
// Mirrors the inline helper in authorship-stamping.spec.ts and
// two-user-suggestion-flow.spec.ts — same shape, scoped name suffix.
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
    const email = `authorship-blame-${suffix}@tinycld.org`
    const password = 'AuthorshipBlame1234!'

    const userRes = await fetch(`${PB_URL}/api/collections/users/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: adminToken },
        body: JSON.stringify({
            email,
            password,
            passwordConfirm: password,
            name: `Authorship Blame Tester ${suffix}`,
            username: `ab_${suffix.replace(/-/g, '_')}`,
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
    await page.waitForURL(/\/a\//, { timeout: 15_000 })
}
