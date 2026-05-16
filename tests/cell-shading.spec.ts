import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import {
    login,
    ORG_SLUG,
    TEST_USER_EMAIL,
    TEST_USER_PASSWORD,
} from '../../../../tests/e2e/helpers'

// Mirrors table-toolbar.spec.ts setup. Re-running the .docx → Y.Doc
// → Tiptap bootstrap is the slow part; per-spec timeout matches the
// sibling table tests.
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

function editorRoot(page: Page) {
    return page.locator('.tinycld-document-editor .ProseMirror')
}

async function waitForEditor(page: Page, timeout = 60_000): Promise<void> {
    await expect(editorRoot(page)).toBeVisible({ timeout })
}

async function openTablePopover(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Table', exact: true }).click()
}

test.describe('Text — Cell shading', () => {
    test.setTimeout(TEST_TIMEOUT)

    test('shading button is disabled outside a table and enabled inside', async ({ page }) => {
        const itemId = await uploadDocxAsDriveItem(`shading-disabled-${Date.now()}.docx`)
        await login(page)
        await page.goto(`/a/${ORG_SLUG}/text/${itemId}`)
        await waitForEditor(page)
        await expect(page.getByText(FEATURE_DOC_HEADING).first()).toBeVisible({ timeout: 30_000 })

        await editorRoot(page).click()
        await page.keyboard.press('Home')
        const shadingBtn = page.getByRole('button', { name: 'Cell shading' })
        await expect(shadingBtn).toBeDisabled()

        await page.keyboard.press('End')
        await page.keyboard.press('Enter')
        await openTablePopover(page)
        await page.getByRole('button', { name: '2 by 2 table' }).click()

        await expect(shadingBtn).toBeEnabled()
    })

    test('picking a color writes data-shading + inline background-color to the cell', async ({
        page,
    }) => {
        const itemId = await uploadDocxAsDriveItem(`shading-apply-${Date.now()}.docx`)
        await login(page)
        await page.goto(`/a/${ORG_SLUG}/text/${itemId}`)
        await waitForEditor(page)
        await expect(page.getByText(FEATURE_DOC_HEADING).first()).toBeVisible({ timeout: 30_000 })
        await expect(page.getByText('Complex Tables').first()).toBeVisible({ timeout: 30_000 })

        const tablesBefore = await editorRoot(page).locator('table').count()
        await editorRoot(page).click()
        await page.keyboard.press('End')
        await page.keyboard.press('Enter')
        await openTablePopover(page)
        await page.getByRole('button', { name: '2 by 2 table' }).click()
        await expect(editorRoot(page).locator('table')).toHaveCount(tablesBefore + 1)

        // Open shading menu and pick yellow.
        await page.getByRole('button', { name: 'Cell shading' }).click()
        await page.getByRole('button', { name: 'Apply Yellow shading' }).click()

        const shadedCell = editorRoot(page).locator('[data-shading="#FFFF00"]').first()
        await expect(shadedCell).toBeAttached({ timeout: 10_000 })
        // Inline style should carry the actual color so the visible
        // background is yellow (not just an annotation in the DOM).
        const backgroundColor = await shadedCell.evaluate(
            el => (el as HTMLElement).style.backgroundColor
        )
        expect(backgroundColor.replace(/\s+/g, '')).toMatch(
            /^(rgb\(255,255,0\)|#FFFF00)$/i
        )
    })

    test('picking "None" clears an existing shading', async ({ page }) => {
        const itemId = await uploadDocxAsDriveItem(`shading-clear-${Date.now()}.docx`)
        await login(page)
        await page.goto(`/a/${ORG_SLUG}/text/${itemId}`)
        await waitForEditor(page)
        await expect(page.getByText(FEATURE_DOC_HEADING).first()).toBeVisible({ timeout: 30_000 })
        await expect(page.getByText('Complex Tables').first()).toBeVisible({ timeout: 30_000 })

        const tablesBefore = await editorRoot(page).locator('table').count()
        await editorRoot(page).click()
        await page.keyboard.press('End')
        await page.keyboard.press('Enter')
        await openTablePopover(page)
        await page.getByRole('button', { name: '2 by 2 table' }).click()
        await expect(editorRoot(page).locator('table')).toHaveCount(tablesBefore + 1)

        await page.getByRole('button', { name: 'Cell shading' }).click()
        await page.getByRole('button', { name: 'Apply Yellow shading' }).click()
        await expect(editorRoot(page).locator('[data-shading="#FFFF00"]').first()).toBeAttached()

        await page.getByRole('button', { name: 'Cell shading' }).click()
        await page.getByRole('button', { name: 'Apply None shading' }).click()
        await expect(editorRoot(page).locator('[data-shading="#FFFF00"]')).toHaveCount(0)
    })
})
