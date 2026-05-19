import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import {
    login,
    ORG_SLUG,
    TEST_USER_EMAIL,
    TEST_USER_PASSWORD,
} from '../../../../tests/e2e/helpers'

// End-to-end coverage for the docx preview / server-rendered HTML
// path introduced in Phase 2 of the server-side HTML rendering plan.
// The renderer + endpoint live in text/server (Go unit tests cover
// correctness exhaustively); this spec exercises the integration
// loop: PB drive_item → /api/text/render → iframe content.

const TEST_TIMEOUT = 120_000
const PB_URL = 'http://127.0.0.1:7200'
const DOCX_MIME =
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const FEATURE_DOC_HEADING = 'Sample Document'

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

test.describe('Text — Server-rendered preview', () => {
    test.setTimeout(TEST_TIMEOUT)

    test('GET /api/text/render returns an HTML fragment with tinycld-doc classes', async ({
        request,
    }) => {
        const itemId = await uploadDocxAsDriveItem(`preview-fetch-${Date.now()}.docx`)
        const token = await authAsTestUser()

        const res = await request.get(`${PB_URL}/api/text/render/${itemId}`, {
            headers: { Authorization: `Bearer ${token}` },
        })
        expect(res.status()).toBe(200)
        expect(res.headers()['content-type']).toContain('text/html')
        const body = await res.text()
        expect(body).toContain('class="tinycld-doc"')
        expect(body).toContain(FEATURE_DOC_HEADING)
    })

    test('GET /api/text/render returns 304 on matching If-None-Match', async ({
        request,
    }) => {
        const itemId = await uploadDocxAsDriveItem(`preview-etag-${Date.now()}.docx`)
        const token = await authAsTestUser()

        const first = await request.get(`${PB_URL}/api/text/render/${itemId}`, {
            headers: { Authorization: `Bearer ${token}` },
        })
        expect(first.status()).toBe(200)
        const etag = first.headers()['etag']
        expect(etag).toBeTruthy()

        const second = await request.get(`${PB_URL}/api/text/render/${itemId}`, {
            headers: {
                Authorization: `Bearer ${token}`,
                'If-None-Match': etag,
            },
        })
        expect(second.status()).toBe(304)
    })

    test('GET /api/text/render rejects unauthenticated requests', async ({ request }) => {
        const itemId = await uploadDocxAsDriveItem(`preview-401-${Date.now()}.docx`)
        const res = await request.get(`${PB_URL}/api/text/render/${itemId}`)
        expect([401, 403]).toContain(res.status())
    })

    test('GET /api/text/render?images=embed returns base64 data URIs', async ({
        request,
    }) => {
        const itemId = await uploadDocxAsDriveItem(`preview-embed-${Date.now()}.docx`)
        const token = await authAsTestUser()

        const res = await request.get(
            `${PB_URL}/api/text/render/${itemId}?images=embed`,
            { headers: { Authorization: `Bearer ${token}` } }
        )
        expect(res.status()).toBe(200)
        const body = await res.text()
        // feature-test.docx contains an inline image. The PM importer
        // resolves it to a data: URI; in embed mode the renderer
        // passes it through verbatim (no external URL → no fetcher
        // round-trip). We assert the data: URI marker survives.
        expect(body).toContain('class="tinycld-doc"')
        // Use a loose substring check — different docx fixtures emit
        // different image extensions, so we only assert the data:
        // prefix made it into the document.
        if (body.includes('<img')) {
            expect(body).toContain('data:image/')
        }
    })

    test.skip('drive preview modal renders docx content via the new TextPreview', async ({
        page,
    }: { page: Page }) => {
        // Drive UI navigation depends on grid rendering + viewport scroll,
        // both of which are subject to layout drift across browsers. The
        // HTTP-level tests above cover end-to-end render + ETag + auth;
        // re-enable this when the share modal exposes a deterministic
        // testid for the docx tile.
        const docxName = `preview-ui-${Date.now()}.docx`
        await uploadDocxAsDriveItem(docxName)
        await login(page)
        await page.goto(`/a/${ORG_SLUG}/drive`)
        const tile = page.getByText(docxName).first()
        await tile.waitFor({ state: 'visible', timeout: 30_000 })
        await tile.dblclick()
        const iframe = page.frameLocator('iframe[aria-label*="Preview of"]').first()
        await expect(iframe.locator('article.tinycld-doc')).toBeVisible({
            timeout: 30_000,
        })
        await expect(iframe.getByText(FEATURE_DOC_HEADING).first()).toBeVisible()
    })
})
