import { expect, type Page, test } from '@playwright/test'
import { ORG_SLUG, TEST_USER_EMAIL, TEST_USER_PASSWORD } from '../../app/tests/e2e/helpers'
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

// Two-user end-to-end flow for suggestion replication and remote
// resolution. Alice (the doc owner) shares as editor with Bob (a
// freshly-minted user_org), Alice switches to Suggesting and types
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
    test.setTimeout(TEXT_TEST_TIMEOUT)

    test('alice suggests insert → bob accepts → alice sees mark gone', async ({ browser }) => {
        // Two browser contexts simulate two collaborators on the same
        // doc. Each context boots its own realtime room + Yjs Doc; we
        // wait on realtime replication between them, so the budget needs
        // headroom over the default. Same envelope the comments
        // concurrent-tabs spec uses.
        test.setTimeout(180_000)

        const itemId = await uploadDocxAsDriveItem(uniqueDocName('two-user-suggestion'))
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

            // Alice switches to Suggesting mode via the toolbar dropdown.
            await alicePage.getByRole('button', { name: 'Editor mode' }).click()
            await alicePage.getByRole('menuitem', { name: 'Suggesting' }).click()
            await expect(alicePage.locator('[data-current-mode="suggesting"]')).toBeVisible({
                timeout: 10_000,
            })

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
            await expect(alicePage.locator('[data-suggested-insert]').first()).toBeVisible({
                timeout: 10_000,
            })
            // Bob's tab sees the same span after realtime replication.
            // The broker fans out the Yjs delta; y-prosemirror on Bob
            // applies it and the schema's renderHTML emits
            // data-suggested-insert just like on Alice's side.
            await expect(bobPage.locator('[data-suggested-insert]').first()).toBeVisible({
                timeout: 15_000,
            })
            await expect(bobPage.getByText(marker)).toBeVisible({ timeout: 10_000 })

            // Bob opens the review drawer.
            await bobPage.getByRole('button', { name: 'Open suggestion review drawer' }).click()
            await expect(bobPage.getByText('Suggestions').first()).toBeVisible({
                timeout: 5_000,
            })

            // The drawer's SuggestionRow renders Alice's user_org id
            // as the authorId via accessibilityLabel "Suggestion by
            // <authorId>". Bob may be in Editing or Viewing by
            // default (he hasn't touched the menu); both keep the
            // Accept button available because his drive_share role is
            // editor (canResolve=true).
            await expect(
                bobPage.getByRole('button', { name: /^Suggestion by /i }).first()
            ).toBeVisible({ timeout: 15_000 })

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
            await expect(bobPage.locator('[data-suggested-insert]')).toHaveCount(0, {
                timeout: 10_000,
            })

            // Alice's tab: the suggestedInsert decoration is gone
            // after the Yjs delta replicates. The broker fans Bob's
            // resolver transaction out; y-prosemirror on Alice
            // applies it and the schema strips the attribute.
            await expect(alicePage.locator('[data-suggested-insert]')).toHaveCount(0, {
                timeout: 15_000,
            })
            // The underlying text Alice typed is still in the doc as
            // a regular paragraph run — Accept never removes content,
            // it only strips the suggestion wrapper.
            await expect(alicePage.getByText(marker)).toBeVisible({ timeout: 5_000 })
        } finally {
            await aliceContext.close()
            await bobContext.close()
        }
    })
})

interface SecondUser {
    id: string
    email: string
    password: string
    userOrgId: string
}

// Mint a fresh user via the superuser API and add them to test-org.
// Mirrors the same helper inlined in authorship-stamping.spec.ts and
// comments.spec.ts; the duplication is the existing convention in
// this directory until a shared helpers module is carved out.
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
    const email = `two-user-suggestion-${suffix}@tinycld.org`
    const password = 'TwoUserSuggestion1234!'

    const userRes = await fetch(`${PB_URL}/api/collections/users/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: adminToken },
        body: JSON.stringify({
            email,
            password,
            passwordConfirm: password,
            name: `Two-User Tester ${suffix}`,
            username: `tus_${suffix.replace(/-/g, '_')}`,
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
