import { expect, test } from '@playwright/test'
import { editorRoot, openFreshTextDocument, PB_URL, TEXT_TEST_TIMEOUT } from './_menubar-helpers'

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

        // The drawer opens and the new thread appears.
        await expect(page.getByText('First thought')).toBeVisible()

        // Reply within the same thread.
        const replyComposer = page.getByRole('textbox', { name: 'body' }).first()
        await replyComposer.fill('Follow-up reply')
        await page.getByRole('button', { name: 'Reply', exact: true }).click()
        await expect(page.getByText('Follow-up reply')).toBeVisible()

        // Resolve the thread.
        await page.getByRole('button', { name: 'Resolve comment' }).first().click()
        // The "Open" filter chip count should drop; the thread shows the
        // resolved timestamp + a Re-open affordance.
        await expect(page.getByRole('button', { name: 'Re-open comment' })).toBeVisible()

        // Re-open it.
        await page.getByRole('button', { name: 'Re-open comment' }).click()
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
        await expect(page.getByText('anchored thought')).toBeVisible()

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
})

// Returns up to a handful of user_org rows in the test user's org
// belonging to *other* users. Used by the mention test to pick a real
// target without requiring a fresh seed step.
async function fetchOtherUserOrgs(
    request: import('@playwright/test').APIRequestContext
): Promise<Array<{ id: string; user: string }>> {
    const adminRes = await request.post(
        `${PB_URL}/api/collections/_superusers/auth-with-password`,
        {
            data: {
                identity: process.env.ADMIN_USER_LOGIN ?? 'admin@tinycld.org',
                password: process.env.ADMIN_USER_PW ?? 'AdminPass1234!',
            },
        }
    )
    if (!adminRes.ok()) return []
    const { token } = (await adminRes.json()) as { token: string }

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
    const adminRes = await request.post(
        `${PB_URL}/api/collections/_superusers/auth-with-password`,
        {
            data: {
                identity: process.env.ADMIN_USER_LOGIN ?? 'admin@tinycld.org',
                password: process.env.ADMIN_USER_PW ?? 'AdminPass1234!',
            },
        }
    )
    if (!adminRes.ok()) return null
    const { token } = (await adminRes.json()) as { token: string }

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
