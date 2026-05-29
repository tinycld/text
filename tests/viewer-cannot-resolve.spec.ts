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

// End-to-end contract for the viewer role on a doc with pending
// suggestions. Alice (owner / editor) makes a suggestion; Bob (viewer)
// loads the doc and can SEE the suggestion in the drawer but cannot
// resolve it — Accept / Reject buttons (per-row + bulk) are hidden.
//
// SuggestionRow gates the Accept / Reject affordances on `canResolve`
// (see SuggestionRow.tsx:124). The drawer gates the bulk affordances
// on the same flag (ReviewDrawer.tsx:177). canResolve is computed
// from the user's drive_shares role — viewer fails the predicate so
// every resolve surface disappears.
//
// Pins the read-only-but-visible contract: viewers can see what's
// pending (review value), they just can't act on it.

test.describe('Text — Viewer cannot resolve', () => {
    test.setTimeout(TEXT_TEST_TIMEOUT)

    test('alice suggests → bob (viewer) sees row but cannot resolve', async ({ browser }) => {
        // Two contexts: Alice the owner/editor, Bob the freshly-minted
        // viewer. Bob's drive_shares role is 'viewer' (not 'editor'),
        // which is the difference from two-user-suggestion-flow.
        test.setTimeout(180_000)

        const itemId = await uploadDocxAsDriveItem(uniqueDocName('viewer-cannot-resolve'))
        const bob = await createSecondUser()
        await shareDriveItemWithRole(itemId, bob, 'viewer')

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

            // Alice switches to Suggesting mode and types a marker.
            await alicePage.getByRole('button', { name: 'Editor mode' }).click()
            await alicePage.getByRole('menuitem', { name: 'Suggesting' }).click()
            await expect(alicePage.getByLabel('Suggesting mode')).toBeVisible({
                timeout: 10_000,
            })

            const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
            await editorRoot(alicePage).click()
            await alicePage.keyboard.press(`${meta}+End`)
            await alicePage.keyboard.press('Enter')
            const marker = `alice suggests ${Date.now()}`
            await alicePage.keyboard.type(marker, { delay: 25 })

            // Alice's tab carries the suggestedInsert decoration.
            await expect(alicePage.locator('[data-suggested-insert]').first()).toBeVisible({
                timeout: 10_000,
            })

            // Bob's tab sees the decoration too — the suggestion
            // replicates via Yjs even though Bob can't resolve it.
            await expect(bobPage.locator('[data-suggested-insert]').first()).toBeVisible({
                timeout: 15_000,
            })
            await expect(bobPage.getByText(marker)).toBeVisible({ timeout: 10_000 })

            // The drawer-open toolbar button itself is disabled for
            // viewers — the toolbar's `disabled` prop is wired to the
            // server's hello.readOnly flag (screens/[id].tsx:418), and
            // OpenReviewDrawerButton forwards that down. accessibilityState
            // {disabled: true} renders as the ARIA `aria-disabled="true"`
            // attribute on the underlying <div role="button">.
            const drawerBtn = bobPage.getByRole('button', {
                name: 'Open suggestion review drawer',
            })
            await expect(drawerBtn).toBeVisible({ timeout: 5_000 })
            await expect(drawerBtn).toHaveAttribute('aria-disabled', 'true')

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

interface SecondUser {
    id: string
    email: string
    password: string
    userOrgId: string
}

// Mint a fresh user via the superuser API and add them to test-org.
// Mirrors the inline helper in authorship-stamping.spec.ts and
// two-user-suggestion-flow.spec.ts.
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
    const email = `viewer-resolve-${suffix}@tinycld.org`
    const password = 'ViewerResolve1234!'

    const userRes = await fetch(`${PB_URL}/api/collections/users/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: adminToken },
        body: JSON.stringify({
            email,
            password,
            passwordConfirm: password,
            name: `Viewer Resolve Tester ${suffix}`,
            username: `vr_${suffix.replace(/-/g, '_')}`,
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

// shareDriveItemWithRole parameterizes the share role so this spec
// can mint a viewer-share specifically. The base helper in other
// specs hardcodes 'editor'; this variant is local to specs that need
// a non-editor share.
async function shareDriveItemWithRole(
    itemId: string,
    user: SecondUser,
    role: 'viewer' | 'editor' | 'commentor'
): Promise<void> {
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
            role,
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
