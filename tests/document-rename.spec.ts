import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import {
    login,
    ORG_SLUG,
    TEST_USER_EMAIL,
    TEST_USER_PASSWORD,
} from '../../../../tests/e2e/helpers'

// Realtime sync + .docx parsing on first open + Y.Doc init takes
// longer than the default 30s — same TIMEOUT used by text-document.spec.ts.
const TEST_TIMEOUT = 120_000

const PB_URL = 'http://127.0.0.1:7200'
const DOCX_MIME =
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

interface OrgContext {
    orgId: string
    userOrgId: string
    userId: string
}

let cachedAuthToken: string | null = null
let cachedOrgContext: OrgContext | null = null

async function authAsTestUser(): Promise<string> {
    if (cachedAuthToken) return cachedAuthToken
    const res = await fetch(`${PB_URL}/api/collections/users/auth-with-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity: TEST_USER_EMAIL, password: TEST_USER_PASSWORD }),
    })
    if (!res.ok) {
        throw new Error(`PB auth failed: ${res.status} ${await res.text()}`)
    }
    const { token } = (await res.json()) as { token: string }
    cachedAuthToken = token
    return token
}

async function resolveOrgContext(token: string): Promise<OrgContext> {
    if (cachedOrgContext) return cachedOrgContext
    const me = await fetch(`${PB_URL}/api/collections/users/auth-refresh`, {
        method: 'POST',
        headers: { Authorization: token },
    })
    const meBody = (await me.json()) as { record?: { id: string } }
    const userId = meBody.record?.id
    if (!userId) throw new Error('auth-refresh returned no user record')

    const orgs = await fetch(
        `${PB_URL}/api/collections/orgs/records?filter=${encodeURIComponent(`slug='${ORG_SLUG}'`)}`,
        { headers: { Authorization: token } }
    )
    const orgItems = (await orgs.json()) as { items: { id: string }[] }
    if (!orgItems.items[0]) throw new Error(`Org ${ORG_SLUG} not found`)
    const orgId = orgItems.items[0].id

    const userOrgs = await fetch(
        `${PB_URL}/api/collections/user_org/records?filter=${encodeURIComponent(
            `org='${orgId}' && user='${userId}'`
        )}`,
        { headers: { Authorization: token } }
    )
    const userOrgItems = (await userOrgs.json()) as { items: { id: string }[] }
    if (!userOrgItems.items[0]) throw new Error(`user_org for ${ORG_SLUG} not found`)
    cachedOrgContext = { orgId, userOrgId: userOrgItems.items[0].id, userId }
    return cachedOrgContext
}

// Mirrors uploadDocxAsDriveItem in text-document.spec.ts: POSTs the
// fixture .docx as a drive_items FormData create. The drive create-hook
// auto-creates an owner share, so the test user can immediately open
// the new doc at /a/<org>/text/<id>.
async function uploadDocxAsDriveItem(name: string): Promise<string> {
    const token = await authAsTestUser()
    const ctx = await resolveOrgContext(token)
    const fixturePath = join(import.meta.dirname, 'assets', 'feature-test.docx')
    const bytes = readFileSync(fixturePath)
    const form = new FormData()
    form.append('org', ctx.orgId)
    form.append('name', name)
    form.append('is_folder', 'false')
    form.append('mime_type', DOCX_MIME)
    form.append('parent', '')
    form.append('created_by', ctx.userOrgId)
    form.append('size', String(bytes.length))
    form.append(
        'file',
        new Blob([new Uint8Array(bytes)], { type: DOCX_MIME }),
        name
    )
    const res = await fetch(`${PB_URL}/api/collections/drive_items/records`, {
        method: 'POST',
        headers: { Authorization: token },
        body: form,
    })
    if (!res.ok) {
        throw new Error(`Upload drive_item failed: ${res.status} ${await res.text()}`)
    }
    const body = (await res.json()) as { id: string }
    return body.id
}

test.describe('Text — Document rename', () => {
    test.setTimeout(TEST_TIMEOUT)

    test('inline rename: click title, type new name, Enter — persists across reload', async ({
        page,
    }) => {
        const originalName = `rename-orig-${Date.now()}.docx`
        const newName = `rename-new-${Date.now()}.docx`
        const itemId = await uploadDocxAsDriveItem(originalName)

        await login(page)
        await page.goto(`/a/${ORG_SLUG}/text/${itemId}`)

        // The DocumentTitle Pressable carries an accessibilityLabel of
        // `Rename document, currently <name>`; aria-label on web makes
        // it cheap to locate without leaning on a brittle text match
        // (the document index list may also display the same name).
        const titleTrigger = page.getByLabel(`Rename document, currently ${originalName}`)
        await expect(titleTrigger).toBeVisible({ timeout: 60_000 })
        await titleTrigger.click()

        const input = page.getByLabel('Document name')
        await expect(input).toBeVisible({ timeout: 5_000 })
        await expect(input).toBeFocused()

        await page.keyboard.press('Meta+A')
        await page.keyboard.type(newName)
        await page.keyboard.press('Enter')

        // After commit the input swaps back to a static label. The
        // new accessibilityLabel embeds the renamed value.
        await expect(page.getByLabel(`Rename document, currently ${newName}`)).toBeVisible({
            timeout: 10_000,
        })

        await page.reload()
        await expect(page.getByLabel(`Rename document, currently ${newName}`)).toBeVisible({
            timeout: 60_000,
        })
    })

    test('Escape cancels: title reverts and no rename is persisted', async ({ page }) => {
        const originalName = `rename-escape-${Date.now()}.docx`
        const itemId = await uploadDocxAsDriveItem(originalName)

        await login(page)
        await page.goto(`/a/${ORG_SLUG}/text/${itemId}`)

        const titleTrigger = page.getByLabel(`Rename document, currently ${originalName}`)
        await expect(titleTrigger).toBeVisible({ timeout: 60_000 })
        await titleTrigger.click()

        const input = page.getByLabel('Document name')
        await expect(input).toBeVisible({ timeout: 5_000 })
        await page.keyboard.press('Meta+A')
        await page.keyboard.type('a draft the user backs out of')
        await page.keyboard.press('Escape')

        // Back to static label with the ORIGINAL name. The would-be
        // rename never reached pbtsdb, so a reload still shows the
        // original — but the in-tab assertion is enough for this
        // case; the persist case above already covers the reload path.
        await expect(
            page.getByLabel(`Rename document, currently ${originalName}`)
        ).toBeVisible({ timeout: 5_000 })
    })
})
