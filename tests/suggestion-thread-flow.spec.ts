import { expect, type Page, test } from '@playwright/test'
import { ORG_SLUG, TEST_USER_EMAIL, TEST_USER_PASSWORD } from '../../tinycld/tests/e2e/helpers'
import {
    editorRoot,
    openFreshTextDocument,
    PB_URL,
    uniqueDocName,
    uploadDocxAsDriveItem,
    waitForEditor,
} from './_menubar-helpers'

// End-to-end coverage for the suggestion-thread feature (Phase 5 +
// Tasks 1–6). The thread lets a reviewer reply to a suggestion in the
// drawer, @mention collaborators, and have that mention fire the
// existing comment-notification pipeline. Behind the scenes:
//   1. The reply persists as a `text_comments` row with `suggestion_id`
//      set + a synthetic `comment_id` (the discriminator that keeps it
//      out of the regular comments-drawer groupings).
//   2. A `@user` token writes a `comment_mentions` row tied to the same
//      text_comments record; the existing notify hook produces a
//      `notifications` row whose deep-link uses `?focusSuggestion=<id>`
//      so the recipient lands on the focused row.
//   3. Resolving the suggestion deletes the Y.Map entry; the server-side
//      cleanup pass (Task 6) stamps `archived_at` on every matching
//      `text_comments` row so it falls off live queries while staying
//      auditable.
//
// These three tests pin those three contracts.

test.describe('Text — Suggestion thread flow', () => {
    test('focused row: reply persists as a text_comments row with suggestion_id', async ({
        page,
        request,
    }) => {
        const itemId = await openFreshTextDocument(page, 'sug-thread-reply')
        await editorRoot(page).click()
        await waitForEditor(page)

        // Switch into Suggesting mode and type a phrase — surfaces as a
        // suggestedInsert mark with a fresh suggestionId in the Y.Map.
        await page.getByRole('button', { name: 'Editor mode' }).click()
        await page.getByRole('menuitem', { name: 'Suggesting' }).click()
        await expect(page.locator('[data-current-mode="suggesting"]')).toBeVisible()

        await editorRoot(page).click()
        const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
        await page.keyboard.press(`${meta}+End`)
        await page.keyboard.press('Enter')
        const phrase = `thread reply target ${Date.now()}`
        await page.keyboard.type(phrase, { delay: 25 })
        await expect(page.locator('[data-suggested-insert]').first()).toBeVisible()

        // Wait for the suggestion to materialize in the Y.Map. Read out
        // the single suggestionId so we can scope the PB assertion later.
        const suggestionId = await page
            .waitForFunction(() => {
                const w = window as unknown as {
                    __tinyTextDoc?: {
                        getMap: (name: string) => {
                            size: number
                            keys: () => Iterable<string>
                        }
                    }
                }
                const map = w.__tinyTextDoc?.getMap('suggestions')
                if (!map || map.size === 0) return null
                const first = Array.from(map.keys())[0]
                return first ?? null
            }, null)
            .then(handle => handle.jsonValue() as Promise<string>)
        expect(suggestionId).toBeTruthy()

        // Clicking the decoration opens the drawer focused on the row,
        // which renders the SuggestionThread body (Task 4). The thread
        // root carries data-testid="suggestion-thread".
        await page.locator('[data-suggested-insert]').first().click()
        await expect(page.getByText('Suggestions').first()).toBeVisible()
        await expect(page.locator('[data-testid="suggestion-thread"]')).toBeVisible()

        // Reply through the composer. The composer's textbox carries the
        // accessibility label "body" from the underlying MentionInput
        // (which mirrors the regular comment composer). Submit lands a
        // text_comments row + clears the field.
        //
        // We type via pressSequentially (instead of .fill()) because the
        // MentionInput is a react-native-web TextInput backed by
        // react-hook-form's controller. .fill() sets the DOM value
        // directly and dispatches a single input event, but RN-web's
        // change synthesis can drop that single-shot event so the
        // controller never receives the update — and submit fires with
        // an empty body, failing zod's min(1) and silently dropping
        // the click. pressSequentially streams real keystrokes that
        // RN-web's bridge converts into onChangeText calls one char at
        // a time.
        const replyBody = `looks good to me ${Date.now()}`
        const composer = page.getByRole('textbox', { name: 'body' }).first()
        await composer.click()
        await composer.pressSequentially(replyBody, { delay: 5 })
        // The composer is in submitOnEnter mode (see
        // SuggestionReplyComposer.tsx), so there's no explicit submit
        // button — Enter fires the submit handler. Shift+Enter would
        // insert a newline.
        await composer.press('Enter')

        // The composer clears after submit. Form reset wires through
        // react-hook-form's reset({ body: '' }) in CommentComposer.
        // Acts as the deterministic "form submission landed" signal —
        // assert this BEFORE the PB-side check so a slow live query
        // doesn't mask a no-op click.
        await expect(composer).toHaveValue('')

        // PB-side: the row landed with suggestion_id set + a synthetic
        // comment_id distinct from the suggestionId (the adapter uses
        // newRecordId() for the comment_id discriminator).
        const row = await waitForTextCommentBySuggestion(request, suggestionId)
        expect(row).toBeTruthy()
        expect(row?.suggestion_id).toBe(suggestionId)
        expect(row?.body).toBe(replyBody)
        expect(row?.comment_id).toBeTruthy()
        expect(row?.comment_id).not.toBe(suggestionId)
        expect(row?.drive_item).toBe(itemId)
        expect(row?.archived_at ?? '').toBe('')
    })

    test('@mention on a suggestion reply writes a focusSuggestion-deep-linked notification', async ({
        browser,
        request,
    }) => {
        // Two-user setup: Alice (the seeded test user) owns the doc and
        // posts a suggestion + a reply mentioning Bob; we then assert
        // Bob's notifications row lands with ?focusSuggestion=<id> so
        // clicking it deep-links into the focused thread on the doc.

        const itemId = await uploadDocxAsDriveItem(uniqueDocName('sug-thread-mention'))
        const bob = await createSecondUser()
        await shareDriveItemWith(itemId, bob)

        const ctx = await browser.newContext()
        try {
            const alicePage = await ctx.newPage()
            await loginAs(alicePage, TEST_USER_EMAIL, TEST_USER_PASSWORD)
            await alicePage.goto(`/a/${ORG_SLUG}/text/${itemId}`)
            await waitForEditor(alicePage)

            // Alice writes a suggestion.
            await alicePage.getByRole('button', { name: 'Editor mode' }).click()
            await alicePage.getByRole('menuitem', { name: 'Suggesting' }).click()
            await expect(alicePage.locator('[data-current-mode="suggesting"]')).toBeVisible()
            await editorRoot(alicePage).click()
            const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
            await alicePage.keyboard.press(`${meta}+End`)
            await alicePage.keyboard.press('Enter')
            const phrase = `mention target ${Date.now()}`
            await alicePage.keyboard.type(phrase, { delay: 25 })
            await expect(alicePage.locator('[data-suggested-insert]').first()).toBeVisible()

            // Capture the suggestionId so we can assert the deep-link URL.
            const suggestionId = await alicePage
                .waitForFunction(() => {
                    const w = window as unknown as {
                        __tinyTextDoc?: {
                            getMap: (name: string) => {
                                size: number
                                keys: () => Iterable<string>
                            }
                        }
                    }
                    const map = w.__tinyTextDoc?.getMap('suggestions')
                    if (!map || map.size === 0) return null
                    const first = Array.from(map.keys())[0]
                    return first ?? null
                }, null)
                .then(handle => handle.jsonValue() as Promise<string>)

            // Click the decoration to focus the row's thread.
            await alicePage.locator('[data-suggested-insert]').first().click()
            await expect(alicePage.locator('[data-testid="suggestion-thread"]')).toBeVisible()

            // Type a reply with an embedded mention token. The wire
            // format `[[@<userOrgId>]]` is what the composer would emit
            // after the user picked Bob from the @-popover; filling it
            // directly side-steps the popover keyboard dance and pins the
            // server contract (the notify hook fires off the mention row,
            // not the dropdown UI).
            const composer = alicePage.getByRole('textbox', { name: 'body' }).first()
            await composer.click()
            await composer.fill(`Pinging [[@${bob.userOrgId}]] please review`)
            // submitOnEnter mode — Enter submits, no Reply button rendered.
            await composer.press('Enter')

            // Wait for the comment to land in PB so we can pin the
            // mention assertion to its id.
            const comment = await waitForTextCommentBySuggestion(request, suggestionId)
            expect(comment).toBeTruthy()
            expect(comment?.suggestion_id).toBe(suggestionId)

            // The composer wrote one comment_mentions row pointing at
            // Bob's user_org. The notify hook keys off that insert.
            const mention = await waitForCommentMention(request, comment?.id ?? '', bob.userOrgId)
            expect(mention).toBeTruthy()
            expect(mention?.mentioned_user_org).toBe(bob.userOrgId)
            expect(mention?.comment_collection).toBe('text_comments')

            // Bob's notification arrives. The hook is async (goroutine
            // off the request thread), so we poll a generous budget. The
            // notify hook's URL builder treats suggestion_id as the
            // priority discriminator: if set, the URL uses
            // ?focusSuggestion=<id> instead of ?thread=<thread>.
            const notif = await waitForNotification(request, bob.id, 'comment_mention', itemId)
            expect(notif).toBeTruthy()
            expect(notif?.type).toBe('comment_mention')
            expect(notif?.url).toContain(`/${itemId}?focusSuggestion=${suggestionId}`)
            expect(notif?.url).not.toContain('?thread=')
        } finally {
            await ctx.close()
        }
    })

    test('accepting a suggestion archives discussion replies via the cleanup hook', async ({
        page,
        request,
    }) => {
        const _itemId = await openFreshTextDocument(page, 'sug-thread-archive')
        await editorRoot(page).click()
        await waitForEditor(page)

        // Switch to Suggesting → type → mark lands.
        await page.getByRole('button', { name: 'Editor mode' }).click()
        await page.getByRole('menuitem', { name: 'Suggesting' }).click()
        await expect(page.locator('[data-current-mode="suggesting"]')).toBeVisible()
        await editorRoot(page).click()
        const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
        await page.keyboard.press(`${meta}+End`)
        await page.keyboard.press('Enter')
        const phrase = `archive target ${Date.now()}`
        await page.keyboard.type(phrase, { delay: 25 })
        await expect(page.locator('[data-suggested-insert]').first()).toBeVisible()

        const suggestionId = await page
            .waitForFunction(() => {
                const w = window as unknown as {
                    __tinyTextDoc?: {
                        getMap: (name: string) => {
                            size: number
                            keys: () => Iterable<string>
                        }
                    }
                }
                const map = w.__tinyTextDoc?.getMap('suggestions')
                if (!map || map.size === 0) return null
                const first = Array.from(map.keys())[0]
                return first ?? null
            }, null)
            .then(handle => handle.jsonValue() as Promise<string>)

        // Switch to Editing so the resolver's mark-strip isn't
        // re-intercepted as a fresh suggestion (the orphan-auto-delete
        // spec documents the same discipline; without this Accept
        // would re-stamp the text as another suggestion).
        await page.getByRole('button', { name: 'Editor mode' }).click()
        await page.getByRole('menuitem', { name: 'Editing' }).click()
        await expect(page.locator('[data-current-mode="editing"]')).toBeVisible()

        // Focus the row → thread body visible → post a reply.
        await page.locator('[data-suggested-insert]').first().click()
        await expect(page.locator('[data-testid="suggestion-thread"]')).toBeVisible()
        const composer = page.getByRole('textbox', { name: 'body' }).first()
        await composer.click()
        await composer.fill(`pre-archive reply ${Date.now()}`)
        // submitOnEnter mode — Enter submits, no Reply button rendered.
        await composer.press('Enter')

        // Reply lands in PB with archived_at empty (live row).
        const reply = await waitForTextCommentBySuggestion(request, suggestionId)
        expect(reply).toBeTruthy()
        expect(reply?.archived_at ?? '').toBe('')

        // Accept the focused suggestion. The thread renders the Accept
        // button (accessibilityLabel="Accept suggestion") inside the
        // focused panel. Clicking it strips the suggestedInsert mark,
        // the suggestion bridge's auto-delete pass observes the next
        // transaction and removes the Y.Map row — and the server's
        // suggestion_discussion_cleanup hook (Task 6) stamps the row's
        // archived_at on its broker round-trip.
        await page.getByRole('button', { name: 'Accept suggestion' }).first().click()

        // Y.Map empties out — the auto-delete pass landed.
        await expect
            .poll(async () =>
                page.evaluate(() => {
                    const w = window as unknown as {
                        __tinyTextDoc?: { getMap: (n: string) => { size: number } }
                    }
                    return w.__tinyTextDoc?.getMap('suggestions').size ?? -1
                })
            )
            .toBe(0)

        // The discussion reply is archived. The cleanup hook is fired
        // server-side as a downstream of the y-doc update; polling
        // 15s gives the goroutine a generous window even under worker
        // contention.
        await expect
            .poll(async () => {
                const row = await fetchTextCommentById(request, reply?.id ?? '')
                return row?.archived_at ?? ''
            })
            .not.toBe('')
    })
})

// ---- PB helpers ----

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

interface TextCommentRow {
    id: string
    drive_item: string
    comment_id: string
    body: string
    author: string
    suggestion_id?: string
    archived_at?: string
}

// Poll for the (single) text_comments row tied to a suggestion. The
// adapter writes one row per reply; in these specs we post exactly one
// reply per test so a single match is the expected shape.
async function waitForTextCommentBySuggestion(
    request: import('@playwright/test').APIRequestContext,
    suggestionId: string
): Promise<TextCommentRow | null> {
    const token = await adminToken(request)
    if (!token) return null
    let row: TextCommentRow | undefined
    await expect
        .poll(async () => {
            const res = await request.get(
                `${PB_URL}/api/collections/text_comments/records?filter=${encodeURIComponent(
                    `suggestion_id='${suggestionId}'`
                )}&perPage=5&sort=-created`,
                { headers: { Authorization: token } }
            )
            if (!res.ok()) return undefined
            const body = (await res.json()) as { items: TextCommentRow[] }
            row = body.items[0]
            return row
        })
        .toBeTruthy()
    return row ?? null
}

async function fetchTextCommentById(
    request: import('@playwright/test').APIRequestContext,
    id: string
): Promise<TextCommentRow | null> {
    const token = await adminToken(request)
    if (!token || !id) return null
    const res = await request.get(`${PB_URL}/api/collections/text_comments/records/${id}`, {
        headers: { Authorization: token },
    })
    if (!res.ok()) return null
    return (await res.json()) as TextCommentRow
}

interface CommentMentionRow {
    id: string
    comment_collection: string
    comment_record: string
    mentioned_user_org: string
}

async function waitForCommentMention(
    request: import('@playwright/test').APIRequestContext,
    commentRecord: string,
    mentionedUserOrgId: string
): Promise<CommentMentionRow | null> {
    const token = await adminToken(request)
    if (!token) return null
    let row: CommentMentionRow | undefined
    await expect
        .poll(async () => {
            const res = await request.get(
                `${PB_URL}/api/collections/comment_mentions/records?filter=${encodeURIComponent(
                    `comment_record='${commentRecord}' && mentioned_user_org='${mentionedUserOrgId}'`
                )}&perPage=5`,
                { headers: { Authorization: token } }
            )
            if (!res.ok()) return undefined
            const body = (await res.json()) as { items: CommentMentionRow[] }
            row = body.items[0]
            return row
        })
        .toBeTruthy()
    return row ?? null
}

async function waitForNotification(
    request: import('@playwright/test').APIRequestContext,
    userId: string,
    type: string,
    driveItemId: string
): Promise<{ type: string; url: string } | null> {
    const token = await adminToken(request)
    if (!token) return null
    let match: { type: string; url: string } | undefined
    await expect
        .poll(async () => {
            const res = await request.get(
                `${PB_URL}/api/collections/notifications/records?filter=${encodeURIComponent(
                    `user='${userId}' && type='${type}'`
                )}&perPage=10&sort=-created`,
                { headers: { Authorization: token } }
            )
            if (!res.ok()) return undefined
            const body = (await res.json()) as { items: Array<{ type: string; url: string }> }
            match = body.items.find(n => n.url.includes(driveItemId))
            return match
        })
        .toBeTruthy()
    return match ?? null
}

// ---- Second-user helpers (inlined per the established directory convention) ----

interface SecondUser {
    id: string
    email: string
    password: string
    userOrgId: string
}

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
    const email = `sug-thread-${suffix}@tinycld.org`
    const password = 'SugThread1234!'

    const userRes = await fetch(`${PB_URL}/api/collections/users/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: adminTok },
        body: JSON.stringify({
            email,
            password,
            passwordConfirm: password,
            name: `Sug Thread Tester ${suffix}`,
            username: `sug_${suffix.replace(/-/g, '_')}`,
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
    await page.waitForURL(/\/a\//)
}
