import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Locator, type Page } from '@playwright/test'
import { login, TEST_USER_EMAIL, TEST_USER_PASSWORD } from '../../tinycld/tests/e2e/helpers'

export const PB_URL = 'http://127.0.0.1:7200'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export const FEATURE_DOC_HEADING = 'Sample Document'

let cachedAuthToken: string | null = null
let cachedUserId: string | null = null

export async function authAsTestUser(): Promise<string> {
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

// Single-org: the deployment IS the org, so the only context these
// helpers need is the authenticated user id. The org lookups
// this used to do query collections that no longer exist.
async function resolveUserId(token: string): Promise<string> {
    if (cachedUserId) return cachedUserId
    const me = await fetch(`${PB_URL}/api/collections/users/auth-refresh`, {
        method: 'POST',
        headers: { Authorization: token },
    })
    const meBody = (await me.json()) as { record?: { id: string } }
    const userId = meBody.record?.id
    if (!userId) throw new Error('auth-refresh returned no user record')
    cachedUserId = userId
    return userId
}

// Collision-proof unique document name. drive_items treats
// (parent, name) as unique, so two parallel workers uploading in
// the same millisecond with a bare `Date.now()` would collide and the
// second create would 400 — surfacing as a misleading "editor never
// loaded" timeout downstream. Appending a random suffix removes the
// same-millisecond collision window entirely.
export function uniqueDocName(label: string): string {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    return `${label}-${unique}.docx`
}

// Uploads an assets/ fixture as a fresh drive_items row owned by the seeded
// test user. Returns the new row id, which is also the URL segment under
// /text/<id>. Shared by the docx and rtf helpers below.
export async function uploadFixtureAsDriveItem(
    fixtureFile: string,
    mime: string,
    name: string
): Promise<string> {
    const token = await authAsTestUser()
    const userId = await resolveUserId(token)
    const bytes = readFileSync(join(import.meta.dirname, 'assets', fixtureFile))
    const form = new FormData()
    form.append('name', name)
    form.append('is_folder', 'false')
    form.append('mime_type', mime)
    form.append('parent', '')
    form.append('created_by', userId)
    form.append('size', String(bytes.length))
    form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), name)
    const res = await fetch(`${PB_URL}/api/collections/drive_items/records`, {
        method: 'POST',
        headers: { Authorization: token },
        body: form,
    })
    if (!res.ok) {
        throw new Error(`Upload drive_item failed: ${res.status} ${await res.text()}`)
    }
    return ((await res.json()) as { id: string }).id
}

// Uploads tests/assets/feature-test.docx as a fresh drive_items row.
export async function uploadDocxAsDriveItem(name: string): Promise<string> {
    return uploadFixtureAsDriveItem('feature-test.docx', DOCX_MIME, name)
}

// Uploads tests/assets/sample.rtf as a fresh drive_items row with an RTF
// mime, so opening it exercises the server's RTF -> DOCX -> PM bridge.
export async function uploadRtfAsDriveItem(name: string): Promise<string> {
    return uploadFixtureAsDriveItem('sample.rtf', 'application/rtf', name)
}

// Polls drive_items until a non-folder row with `name` exists in the test
// org. Read-only assertion (permitted — the template itself is created
// through the UI): the export's copy mutation resolves asynchronously after
// the ChooseFolderDialog closes, so a spec that immediately looks for the
// template in the UI can race the create. Awaiting server-visibility here
// removes that leg of the race deterministically. Uses the shared test-user
// token so it doesn't depend on any UI state.
export async function waitForTemplateItem(page: Page, name: string): Promise<void> {
    const token = await authAsTestUser()
    const filter = encodeURIComponent(`is_folder=false && name='${name}'`)
    await expect(async () => {
        const res = await page.request.get(
            `${PB_URL}/api/collections/drive_items/records?perPage=1&skipTotal=1&filter=${filter}`,
            { headers: { Authorization: token } }
        )
        expect(res.ok()).toBeTruthy()
        const body = (await res.json()) as { items: unknown[] }
        expect(body.items.length).toBeGreaterThan(0)
    }).toPass({ timeout: 15_000 })
}

export function editorRoot(page: Page): Locator {
    return page.locator('.tinycld-document-editor .ProseMirror')
}

export async function waitForEditor(page: Page): Promise<void> {
    await expect(editorRoot(page)).toBeVisible()
}

// Opens a freshly-uploaded text document and waits for the editor to be
// ready, including the fixture's H1 (the deterministic "Y.Doc seeded +
// Tiptap bound" signal — once it renders, every command path the specs
// drive is live). Each spec gets its own document so destructive items
// (Rename, Move to trash, Make a copy) can't poison siblings, and so a
// comment/edit from one scenario can't leak into another's view.
export async function openTextDocument(page: Page, label: string): Promise<string> {
    const itemId = await uploadDocxAsDriveItem(uniqueDocName(label))
    await login(page)
    await page.goto(`/text/${itemId}`)
    await waitForEditor(page)
    // Scope the heading match to the editor: a bare getByText also matches the
    // frozen no-file-panel sibling's "<name>.docx" recent-files label (the app
    // shell keeps prior screens mounted via freezeOnBlur), and .first() can
    // resolve to that hidden DOM-earlier element.
    await expect(editorRoot(page).getByText(FEATURE_DOC_HEADING).first()).toBeVisible()
    return itemId
}

// Backwards-compatible alias. Older specs import this name.
export const openFreshTextDocument = openTextDocument

// Clicks a top-level menubar button (File, Edit, Insert, Format, Help).
// `exact: true` matters because items inside the menus repeat the same
// label (e.g. Edit menu has no nested "Edit" but a stricter match makes
// the helper safe to reuse across menus).
export async function openMenubarMenu(page: Page, label: string): Promise<void> {
    await page.getByRole('button', { name: label, exact: true }).click()
}
