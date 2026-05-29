import { expect, test } from '@playwright/test'
import { ORG_SLUG } from '../../app/tests/e2e/helpers'
import {
    authAsTestUser,
    editorRoot,
    openFreshTextDocument,
    PB_URL,
    TEXT_TEST_TIMEOUT,
    waitForEditor,
} from './_menubar-helpers'

// End-to-end flow for the drive version snapshot / restore round-trip
// against a text document.
//
// Path:
//   1. Type some content into a fresh doc.
//   2. POST /api/drive/versions/snapshot to capture a labeled version.
//      The drive snapshot handler invokes the text package's
//      versionhooks.OnSnapshot (registered in text/server/register.go)
//      which captures the live Y.Doc state alongside the docx blob —
//      the protected roots (clientAuthors, clientFirstSeen, editEvents)
//      can't be reconstructed from docx alone, so the Phase 4 work
//      threads them through a side channel in drive_item_versions.
//   3. Type additional content.
//   4. POST /api/drive/versions/restore. The drive restore handler
//      snapshots the current state first, then writes the version's
//      file + invokes versionhooks.OnRestore. The text hook calls
//      applyVersionRestore which folds the captured Yjs state back
//      into the live server doc.
//   5. Reload the doc page; the editor sees the restored Yjs state
//      and the original content is back.
//
// This spec covers both the docx round-trip and the Phase 4 yjs_state
// channel — restoring picks up the snapshot's full Yjs state, not just
// the bytes of the .docx file.

test.describe('Text — Version snapshot + restore', () => {
    test.setTimeout(TEXT_TEST_TIMEOUT)

    test('snapshot at v1 → edit → restore → original content returns', async ({ page }) => {
        const itemId = await openFreshTextDocument(page, 'version-restore')
        await editorRoot(page).click()
        await waitForEditor(page)

        // Type the v1 content.
        const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
        await editorRoot(page).click()
        await page.keyboard.press(`${meta}+End`)
        await page.keyboard.press('Enter')
        const v1Marker = `version 1 content ${Date.now()}`
        await page.keyboard.type(v1Marker, { delay: 20 })
        await expect(page.getByText(v1Marker)).toBeVisible({ timeout: 10_000 })

        // Give the save coordinator past its debounce window before
        // snapshotting. SaveCoordinator.DefaultDebounceInterval is 3s
        // — the coordinator only flushes Y.Doc → docx → drive_items.file
        // after that long an idle window. Snapshotting earlier would
        // capture the original feature-test.docx (pre-v1), not the
        // v1 content we just typed. 4s leaves headroom past the 3s
        // debounce + the actual write latency.
        await page.waitForTimeout(4_000)

        // Snapshot v1 via the drive API. The endpoint requires auth
        // and a JSON body of {item, label}. We hit it via fetch from
        // node-side (not page-side) so we can use authAsTestUser, the
        // helper that resolves the seeded test user's PB token.
        const token = await authAsTestUser()
        const snapRes = await fetch(`${PB_URL}/api/drive/versions/snapshot`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: token,
            },
            body: JSON.stringify({ item: itemId, label: 'before-edit' }),
        })
        expect(snapRes.ok).toBe(true)

        // Look up the version id we just created. drive_item_versions
        // is filtered to the seeded user via PB rules; we list the
        // user-source rows for this item and grab the most recent.
        const versionsRes = await fetch(
            `${PB_URL}/api/collections/drive_item_versions/records?filter=${encodeURIComponent(
                `item='${itemId}' && source='user'`
            )}&sort=-created`,
            { headers: { Authorization: token } }
        )
        expect(versionsRes.ok).toBe(true)
        const versions = (await versionsRes.json()) as { items: { id: string }[] }
        expect(versions.items.length).toBeGreaterThan(0)
        const versionId = versions.items[0].id

        // Type the additional content.
        await editorRoot(page).click()
        await page.keyboard.press(`${meta}+End`)
        await page.keyboard.press('Enter')
        const v2Marker = `plus more ${Date.now()}`
        await page.keyboard.type(v2Marker, { delay: 20 })
        await expect(page.getByText(v2Marker)).toBeVisible({ timeout: 10_000 })

        // Navigate the page away from the doc BEFORE issuing the
        // restore. Once this tab's WebSocket disconnects (the only
        // client in the room) the broker fires OnEmpty, the
        // SaveCoordinator does its teardown-flush synchronously
        // (DefaultTeardownTimeout caps the wait), and the server-side
        // handle closes (room.go:remove sets serverDoc.Close). The
        // restore can then overwrite drive_items.file in peace, and a
        // subsequent navigation re-opens the room with a FRESH
        // bootstrap from the v1 docx — bypassing the CRDT merge that
        // would otherwise preserve the v2 content in the still-live
        // Y.Doc.
        await page.goto('/')
        // Buffer past the teardown flush + the broker's removeRoom
        // call so a follow-up navigation actually rebootstraps.
        await page.waitForTimeout(3_000)

        // Now issue the restore. The drive handler overwrites
        // drive_items.file with v1's bytes; the OnRestore hook tries
        // to fold yjs_state into the live doc, but the room is now
        // closed so the hook no-ops (no live handle to apply against).
        // The next bootstrap will read the v1 docx fresh.
        const restoreRes = await fetch(`${PB_URL}/api/drive/versions/restore`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: token,
            },
            body: JSON.stringify({ item: itemId, version: versionId }),
        })
        expect(restoreRes.ok).toBe(true)

        // Re-open the doc. New room, fresh bootstrap from the just-
        // restored v1 docx; the editor mounts the v1 content with no
        // v2 residue.
        await page.goto(`/a/${ORG_SLUG}/text/${itemId}`)
        await waitForEditor(page)

        // v1 marker is back; v2 marker is gone.
        await expect(page.getByText(v1Marker)).toBeVisible({ timeout: 15_000 })
        await expect(page.getByText(v2Marker)).not.toBeVisible({ timeout: 5_000 })
    })
})
