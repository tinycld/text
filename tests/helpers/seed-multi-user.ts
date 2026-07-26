import type { Page } from '@playwright/test'

import { PB_URL } from '../_menubar-helpers'

// ─────────────────────────────────────────────────────────────────────────
// Multi-user e2e setup — centralized, deliberately raw-REST.
//
// WHY THIS IS RAW REST (and not UI-driven, per the CLAUDE.md e2e rule):
// The collaboration/authorship/comments specs each need a *second real
// account — a distinct users row so a
// second browser context can sign in as a different person and open a
// shared document. There is no in-app flow an e2e test can drive to
// produce that: the only UI path to a new membership is the email-invite
// flow, which requires an out-of-band mailbox round-trip (accept link,
// set password) that Playwright cannot complete in-process. Minting the
// user + membership directly via the PocketBase superuser API is the
// only feasible setup, and it is genuinely imperative fixture work —
// not application behaviour under test.
//
// Before this module, every one of the 8 multi-user specs carried a
// verbatim copy of createSecondUser / shareDriveItemWith / loginAs (each
// re-authing the superuser inline), with a trailing "// Mirrors the
// helper in …, pending a shared module" comment. This IS that shared
// module: one clearly-named, clearly-justified home for the raw writes.
//
// SCOPE: setup only. Read-only assertions (polling notifications,
// reading back a text_comments row, listing peer users) stay in
// the spec that needs them — the CLAUDE.md rule explicitly permits raw
// REST for read-only assertions, and they're not shared across specs.
// ─────────────────────────────────────────────────────────────────────────

const ADMIN_EMAIL = process.env.ADMIN_USER_LOGIN ?? 'admin@tinycld.org'
const ADMIN_PASSWORD = process.env.ADMIN_USER_PW ?? 'AdminPass1234!'

export interface SecondUser {
    id: string
    email: string
    password: string
}

export type ShareRole = 'viewer' | 'editor' | 'commentor'

// Authenticate as the PocketBase superuser and return the auth token.
// Every setup write below needs superuser rights (creating a user,
// granting a share), so they all funnel through here.
async function superuserToken(): Promise<string> {
    const res = await fetch(`${PB_URL}/api/collections/_superusers/auth-with-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    })
    if (!res.ok) {
        throw new Error(`Superuser auth failed: ${res.status} ${await res.text()}`)
    }
    const { token } = (await res.json()) as { token: string }
    return token
}

// Mint a fresh, verified user with the member role. Single-org: the role
// select on the users auth record IS the membership.
// `label` becomes the email prefix (e.g. 'authorship-blame') so a failing
// run's stray users are traceable to the spec that created them.
export async function createSecondUser(label: string): Promise<SecondUser> {
    const token = await superuserToken()

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const email = `${label}-${suffix}@tinycld.org`
    const password = 'MultiUserTest1234!'

    const userRes = await fetch(`${PB_URL}/api/collections/users/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: token },
        body: JSON.stringify({
            email,
            password,
            passwordConfirm: password,
            name: `${label} tester ${suffix}`,
            username: `mu_${suffix.replace(/-/g, '_')}`,
            verified: true,
            role: 'member',
        }),
    })
    if (!userRes.ok) {
        throw new Error(`Create user failed: ${userRes.status} ${await userRes.text()}`)
    }
    const user = (await userRes.json()) as { id: string }

    return { id: user.id, email, password }
}

// Grant `user` access to a drive item. Defaults to 'editor' (the common
// case for collaboration specs); pass 'viewer' / 'commentor' where a spec
// exercises reduced permissions (viewer-cannot-resolve).
export async function shareDriveItemWith(
    itemId: string,
    user: SecondUser,
    role: ShareRole = 'editor'
): Promise<void> {
    const token = await superuserToken()
    const res = await fetch(`${PB_URL}/api/collections/drive_shares/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: token },
        body: JSON.stringify({
            item: itemId,
            user: user.id,
            role,
            created_by: user.id,
        }),
    })
    if (!res.ok) {
        throw new Error(`Share drive_item failed: ${res.status} ${await res.text()}`)
    }
}

// Sign a page in as an arbitrary user. The shared-test-user login lives
// in tinycld/tests/e2e/helpers (login), but the second collaborator needs
// distinct credentials, which that helper hard-codes — hence this variant.
export async function loginAs(page: Page, identifier: string, password: string): Promise<void> {
    await page.goto('/')
    await page.getByTestId('identifier').fill(identifier)
    await page.getByPlaceholder('Password').fill(password)
    await page.getByText('Sign in', { exact: true }).last().click()
    await page.waitForURL(/\/a\//)
}

// Read the live Y.Doc's clientAuthors map on `page` and return the
// flattened [clientID, userId] entries. The screen exposes the doc via
// the dev-only window.__tinyTextDoc hook (see useDevYDocWindowHook in
// screens/[id].tsx). Callers wrap this in expect.poll to wait for the
// stamping delta's fan-out to land.
export async function readClientAuthors(page: Page): Promise<[string, string][]> {
    return page.evaluate(() => {
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
}
