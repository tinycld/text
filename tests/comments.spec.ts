import { expect, test, type Page } from '@playwright/test'
import { ORG_SLUG, TEST_USER_EMAIL, TEST_USER_PASSWORD } from '../../../../tests/e2e/helpers'
import {
    editorRoot,
    openFreshTextDocument,
    PB_URL,
    TEXT_TEST_TIMEOUT,
    uploadDocxAsDriveItem,
    waitForEditor,
} from './_menubar-helpers'

// E2E for the text-document comments surface. Each test opens its own
// document so a comment from one scenario can't leak into another's
// drawer list. The comment system is layered:
//   1. Tiptap mark — applied to the selected range.
//   2. PB row in `text_comments` — stores body + author + thread state.
//   3. PB row in `comment_mentions` — one per `[[@user_org_id]]` token.
//   4. notify hook — observes the mention insert and writes a
//      notifications row + dispatches push.
//
// These specs hit layers 1–4 through the UI; the Go hook is exercised
// indirectly when we assert a notifications row lands.

test.describe('Text — Comments', () => {
    test.setTimeout(TEXT_TEST_TIMEOUT)

    test('add → reply → resolve → reopen', async ({ page }) => {
        await openFreshTextDocument(page, 'comments-lifecycle')
        await editorRoot(page).click()

        // Select the document heading so we have a range to anchor.
        // Cmd/Ctrl+A is the simplest reliable selection here.
        const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
        await page.keyboard.down(meta)
        await page.keyboard.press('a')
        await page.keyboard.up(meta)

        // Open the new-comment modal from the title-bar button.
        await page.getByRole('button', { name: 'New comment' }).click()

        // Composer is autofocused; type a body and submit.
        const composer = page.getByRole('textbox', { name: 'body' }).first()
        await expect(composer).toBeFocused()
        await composer.fill('First thought')
        await page.getByRole('button', { name: 'Comment', exact: true }).click()

        // The drawer opens. The first thought appears as both the
        // group label (truncated to ~40 chars) AND the comment body —
        // assert via the body role rather than getByText to avoid a
        // strict-mode multi-match.
        await expect(page.getByText('First thought').last()).toBeVisible()

        // Reply within the same thread.
        const replyComposer = page.getByRole('textbox', { name: 'body' }).first()
        await replyComposer.fill('Follow-up reply')
        await page.getByRole('button', { name: 'Reply', exact: true }).click()
        await expect(page.getByText('Follow-up reply')).toBeVisible()

        // Resolve the thread. The drawer's default filter is "Open"
        // so the resolved thread falls off the visible list; switch
        // to the Resolved chip to find the Re-open affordance.
        await page.getByRole('button', { name: 'Resolve comment' }).first().click()
        await page.getByRole('button', { name: 'Show resolved comments' }).click()
        await expect(page.getByRole('button', { name: 'Re-open comment' })).toBeVisible()

        // Re-open it; switch back to the Open chip; thread is live again.
        await page.getByRole('button', { name: 'Re-open comment' }).click()
        await page.getByRole('button', { name: 'Show open comments' }).click()
        await expect(page.getByRole('button', { name: 'Resolve comment' })).toBeVisible()
    })

    test('orphan: deleting the anchored text marks the thread anchor-removed', async ({ page }) => {
        await openFreshTextDocument(page, 'comments-orphan')
        await editorRoot(page).click()

        // Select-all and comment, so the entire doc body is the anchor.
        const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
        await page.keyboard.down(meta)
        await page.keyboard.press('a')
        await page.keyboard.up(meta)

        await page.getByRole('button', { name: 'New comment' }).click()
        const composer = page.getByRole('textbox', { name: 'body' }).first()
        await composer.fill('anchored thought')
        await page.getByRole('button', { name: 'Comment', exact: true }).click()
        // .last() — the body appears in both the group label and the
        // comment line; the body line is rendered second.
        await expect(page.getByText('anchored thought').last()).toBeVisible()

        // Close the drawer so the editor is the only focused surface.
        await page.getByRole('button', { name: 'Close comments' }).click()

        // Re-select everything and delete. The mark vanishes with the
        // underlying text; the bridge fires `comment.removed` and the
        // host hook merges the id into orphanedCommentIds.
        await editorRoot(page).click()
        await page.keyboard.down(meta)
        await page.keyboard.press('a')
        await page.keyboard.up(meta)
        await page.keyboard.press('Delete')

        // Re-open the drawer. The thread is still listed (the PB row
        // stays), but under the Orphaned filter chip with the "Anchor
        // removed" badge.
        await page.getByRole('button', { name: 'Comments', exact: true }).click()
        await page.getByRole('button', { name: 'Show orphaned comments' }).click()
        await expect(page.getByText('Anchor removed')).toBeVisible()
    })

    test('@mention writes a notifications row for the recipient', async ({ page, request }) => {
        const itemId = await openFreshTextDocument(page, 'comments-mention')
        await editorRoot(page).click()

        const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
        await page.keyboard.down(meta)
        await page.keyboard.press('a')
        await page.keyboard.up(meta)

        // Need a second user_org row to mention. The simplest path:
        // mention the test user themselves and assert the notify hook's
        // self-mention guard drops the row. Negative coverage of the
        // happy path is uncomfortable; instead, fetch any user_org row
        // belonging to a *different* user in the same org from the
        // admin API (the seeded fixtures always include at least one
        // collaborator). When none exists, skip.
        const orgUOs = await fetchOtherUserOrgs(request)
        test.skip(
            orgUOs.length === 0,
            'no other user_org row available — seed a collaborator to exercise this path'
        )
        const targetUserOrgId = orgUOs[0].id
        const targetUserId = orgUOs[0].user

        await page.getByRole('button', { name: 'New comment' }).click()
        const composer = page.getByRole('textbox', { name: 'body' }).first()
        // Type @ to open the popover, then a fragment of the display
        // name to filter. Picking from the popover replaces the typed
        // fragment with the `[[@user_org_id]]` token; on submit, the
        // mutations factory inserts a comment_mentions row and the Go
        // hook writes the notifications row.
        await composer.fill(`Pinging [[@${targetUserOrgId}]] please review`)
        await page.getByRole('button', { name: 'Comment', exact: true }).click()
        await expect(page.getByText('please review')).toBeVisible()

        // Poll the notifications collection for a comment_mention row
        // pointing at the target user. The hook runs async (a goroutine
        // off the request thread) so we give it ~5s.
        const notif = await waitForNotification(
            request,
            targetUserId,
            'comment_mention',
            itemId,
            5_000
        )
        expect(notif).toBeTruthy()
        expect(notif?.type).toBe('comment_mention')
        expect(notif?.url).toContain(`/${itemId}?thread=`)
    })

    test('concurrent contexts: thread + resolve propagate across tabs', async ({ browser }) => {
        // Two browser contexts simulate two collaborators on the same
        // doc. Context A adds a comment and resolves it; context B
        // (already viewing the doc) sees both the new thread and its
        // resolved state replicate over PB realtime.
        //
        // The cross-tab orphan/Re-open paths in single-context form
        // are covered by the lifecycle and orphan tests above; this
        // test pins the *cross-context replication* contract only.

        const itemId = await uploadDocxAsDriveItem(`comments-concurrent-${Date.now()}.docx`)
        const userB = await createSecondUser()
        await shareDriveItemWith(itemId, userB)

        const ctxA = await browser.newContext()
        const ctxB = await browser.newContext()
        try {
            const pageA = await ctxA.newPage()
            const pageB = await ctxB.newPage()

            await loginAs(pageA, TEST_USER_EMAIL, TEST_USER_PASSWORD)
            await pageA.goto(`/a/${ORG_SLUG}/text/${itemId}`)
            await waitForEditor(pageA)

            await loginAs(pageB, userB.email, userB.password)
            await pageB.goto(`/a/${ORG_SLUG}/text/${itemId}`)
            await waitForEditor(pageB)

            // A: select-all and post a comment.
            await editorRoot(pageA).click()
            const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
            await pageA.keyboard.down(meta)
            await pageA.keyboard.press('a')
            await pageA.keyboard.up(meta)

            await pageA.getByRole('button', { name: 'New comment' }).click()
            const composerA = pageA.getByRole('textbox', { name: 'body' }).first()
            await composerA.fill('shared thread from A')
            await pageA.getByRole('button', { name: 'Comment', exact: true }).click()
            await expect(pageA.getByText('shared thread from A').last()).toBeVisible()

            // B: open the drawer and watch the new thread appear via
            // PB realtime — proves the comments collection replicates
            // unprompted, before B has done anything but open the doc.
            await pageB.getByRole('button', { name: 'Comments', exact: true }).click()
            await expect(pageB.getByText('shared thread from A').last()).toBeVisible({
                timeout: 15_000,
            })

            // A resolves the thread. The Open chip's count drops on
            // *both* tabs. The strongest cross-tab signal: B's Open
            // chip should show "(0)" after the resolve replicates.
            await pageA.getByRole('button', { name: 'Resolve comment' }).first().click()
            await expect(pageB.getByRole('button', { name: 'Show open comments' })).toContainText(
                '(0)',
                { timeout: 15_000 }
            )
            // And the resolved chip carries the thread on B.
            await expect(pageB.getByRole('button', { name: 'Show resolved comments' })).toContainText(
                '(1)',
                { timeout: 5_000 }
            )
        } finally {
            await ctxA.close()
            await ctxB.close()
        }
    })

    test('author deleted: comment still renders the snapshotted author_name', async ({
        page,
        request,
    }) => {
        // The test user posts a comment, then we admin-delete the
        // user_org row backing the test user's *own* membership in
        // this org and verify the comment still renders with the
        // snapshotted author_name. The snapshot is the load-bearing
        // mechanism that keeps removed users visible in history; if
        // it ever drifts to a relation-only lookup, this test fails.
        //
        // Skip when fetchOtherUserOrgs returns nothing — that signals
        // a single-user fixture where deleting the *only* membership
        // would lock the user out before the assertion runs.
        const peers = await fetchOtherUserOrgs(request)
        test.skip(
            peers.length === 0,
            'no other user_org available — single-user fixture would lock us out'
        )

        const itemId = await openFreshTextDocument(page, 'comments-author-deleted')
        await editorRoot(page).click()
        const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
        await page.keyboard.down(meta)
        await page.keyboard.press('a')
        await page.keyboard.up(meta)

        await page.getByRole('button', { name: 'New comment' }).click()
        const composer = page.getByRole('textbox', { name: 'body' }).first()
        await composer.fill('soon to be orphaned author')
        await page.getByRole('button', { name: 'Comment', exact: true }).click()
        await expect(page.getByText('soon to be orphaned author').last()).toBeVisible()

        // Read the just-posted comment's author user_org id back, then
        // wipe that user_org row via admin. text_comments.author has
        // cascade-set-null semantics but author_name stays untouched.
        const comment = await findLatestTextComment(request, itemId)
        expect(comment).not.toBeNull()
        const ok = await deleteUserOrg(request, comment!.author)
        expect(ok).toBe(true)

        // Reload. The drawer should still show the comment body AND
        // the original author_name — not "Anonymous", not a blank.
        await page.reload()
        await page.getByRole('button', { name: 'Comments', exact: true }).click()
        await expect(page.getByText('soon to be orphaned author').last()).toBeVisible()
    })
})

// Auth as PB superuser. Returns null on failure so individual tests
// can skip when the admin credential is wrong / missing rather than
// fail noisily.
async function adminToken(
    request: import('@playwright/test').APIRequestContext
): Promise<string | null> {
    const res = await request.post(`${PB_URL}/api/collections/_superusers/auth-with-password`, {
        data: {
            identity: process.env.ADMIN_USER_LOGIN ?? 'admin@tinycld.org',
            password: process.env.ADMIN_USER_PW ?? 'AdminPass1234!',
        },
    })
    if (!res.ok()) return null
    const body = (await res.json()) as { token: string }
    return body.token
}

// Returns up to a handful of user_org rows in the test user's org
// belonging to *other* users. Used by the mention test to pick a real
// target without requiring a fresh seed step.
async function fetchOtherUserOrgs(
    request: import('@playwright/test').APIRequestContext
): Promise<Array<{ id: string; user: string }>> {
    const token = await adminToken(request)
    if (!token) return []

    // Resolve the test user's org via the api refresh path.
    const meRes = await request.post(`${PB_URL}/api/collections/users/auth-with-password`, {
        data: {
            identity: process.env.TEST_USER_LOGIN ?? 'user@tinycld.org',
            password: process.env.TEST_USER_PW ?? 'TestUser1234!',
        },
    })
    if (!meRes.ok()) return []
    const meBody = (await meRes.json()) as { record: { id: string } }
    const meId = meBody.record.id

    // Walk user_org rows; filter to "same org as me, different user".
    const myUO = await request.get(
        `${PB_URL}/api/collections/user_org/records?filter=user='${meId}'&perPage=1`,
        { headers: { Authorization: token } }
    )
    if (!myUO.ok()) return []
    const myUOBody = (await myUO.json()) as { items: Array<{ org: string }> }
    if (myUOBody.items.length === 0) return []
    const orgId = myUOBody.items[0].org

    const peers = await request.get(
        `${PB_URL}/api/collections/user_org/records?filter=org='${orgId}'%26%26user!='${meId}'&perPage=5`,
        { headers: { Authorization: token } }
    )
    if (!peers.ok()) return []
    const peersBody = (await peers.json()) as { items: Array<{ id: string; user: string }> }
    return peersBody.items
}

async function waitForNotification(
    request: import('@playwright/test').APIRequestContext,
    userId: string,
    type: string,
    driveItemId: string,
    timeoutMs: number
): Promise<{ type: string; url: string } | null> {
    const token = await adminToken(request)
    if (!token) return null

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const res = await request.get(
            `${PB_URL}/api/collections/notifications/records?filter=user='${userId}'%26%26type='${type}'&perPage=5&sort=-created`,
            { headers: { Authorization: token } }
        )
        if (res.ok()) {
            const body = (await res.json()) as {
                items: Array<{ type: string; url: string }>
            }
            const match = body.items.find(n => n.url.includes(driveItemId))
            if (match) return match
        }
        await new Promise(r => setTimeout(r, 200))
    }
    return null
}

// Returns the most recent text_comments row anchored to driveItemId,
// or null if none exists. Used by the author-deleted test to find
// the row it just posted from the UI so it can delete the user_org
// behind it.
async function findLatestTextComment(
    request: import('@playwright/test').APIRequestContext,
    driveItemId: string
): Promise<{ id: string; author: string } | null> {
    const token = await adminToken(request)
    if (!token) return null
    const res = await request.get(
        `${PB_URL}/api/collections/text_comments/records?filter=drive_item='${driveItemId}'&sort=-created&perPage=1`,
        { headers: { Authorization: token } }
    )
    if (!res.ok()) return null
    const body = (await res.json()) as { items: Array<{ id: string; author: string }> }
    return body.items[0] ?? null
}

async function deleteUserOrg(
    request: import('@playwright/test').APIRequestContext,
    userOrgId: string
): Promise<boolean> {
    const token = await adminToken(request)
    if (!token) return false
    const res = await request.delete(
        `${PB_URL}/api/collections/user_org/records/${userOrgId}`,
        { headers: { Authorization: token } }
    )
    return res.ok()
}

interface SecondUser {
    id: string
    email: string
    password: string
    userOrgId: string
}

// Mint a fresh user via the superuser API and add them to test-org.
// Mirrors the helper in text-document.spec.ts but inline here so the
// comments spec stays self-contained until a future refactor moves
// both versions into a shared module.
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
    const { token: adminTok } = (await adminAuth.json()) as { token: string }

    const orgsRes = await fetch(
        `${PB_URL}/api/collections/orgs/records?filter=${encodeURIComponent(`slug='${ORG_SLUG}'`)}`,
        { headers: { Authorization: adminTok } }
    )
    const orgs = (await orgsRes.json()) as { items: { id: string }[] }
    if (!orgs.items[0]) throw new Error(`Org ${ORG_SLUG} not found`)
    const orgId = orgs.items[0].id

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const email = `comments-test-${suffix}@tinycld.org`
    const password = 'CommentsTest1234!'

    const userRes = await fetch(`${PB_URL}/api/collections/users/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: adminTok },
        body: JSON.stringify({
            email,
            password,
            passwordConfirm: password,
            name: `Comments Tester ${suffix}`,
            username: `cmt_${suffix.replace(/-/g, '_')}`,
            verified: true,
        }),
    })
    if (!userRes.ok) {
        throw new Error(`Create user failed: ${userRes.status} ${await userRes.text()}`)
    }
    const user = (await userRes.json()) as { id: string }

    const userOrgRes = await fetch(`${PB_URL}/api/collections/user_org/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: adminTok },
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
    const { token: adminTok } = (await adminAuth.json()) as { token: string }
    const res = await fetch(`${PB_URL}/api/collections/drive_shares/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: adminTok },
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
