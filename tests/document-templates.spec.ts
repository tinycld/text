// document-templates.spec.ts exercises the drive-backed template flow
// end-to-end, entirely through the UI (no raw PB writes to create the
// template — that's the whole point of the rules):
//
//   1. Open a fresh document, edit it, then File → Export as template… →
//      confirm the folder. This creates a `<name>.tmpl.docx` drive file
//      from the live document (force-flushed first).
//   2. Go to the text index, open the "From template…" picker, find the
//      just-created template, and pick it.
//   3. Verify a new document opens containing the text typed in step 1 —
//      which proves the force-flush captured live edits, not just the
//      last debounced save.

import { expect, type Page, test } from '@playwright/test'

import {
    editorRoot,
    openFreshTextDocument,
    openMenubarMenu,
    waitForTemplateItem,
} from './_menubar-helpers'

// A distinctive phrase typed into the document right before export. If it
// shows up in the doc created from the template, the flush worked.
const FRESH_MARKER = 'FreshTemplateMarker'

test.describe('Text — Document templates', () => {
    test('export a document as a template, then create a new doc from it', async ({ page }) => {
        await openFreshTextDocument(page, 'tmpl-export')

        // Type a marker so we can later prove the exported template
        // captured live edits (not the last-flushed blob).
        await editorRoot(page).click()
        await page.keyboard.type(` ${FRESH_MARKER}`)

        const templateLabel = await exportAsTemplate(page)

        // The template must actually exist server-side before the menu can
        // offer it. exportAsTemplate confirms the folder dialog, but the
        // ChooseFolderDialog closes on click *before* the copy mutation's
        // raw multipart create resolves — so at that point the `.tmpl.docx`
        // row may not exist yet. Confirm it landed with a read-only query
        // (writes still go through the UI; this is a read-only assertion) so
        // we're never waiting on a menu item for a row that isn't there.
        await waitForTemplateItem(page, `${templateLabel}.tmpl.docx`)

        // Open the picker from the File menu (in-app — a page.goto would
        // tear down the SPA and cancel the on-demand drive_items fetch the
        // picker depends on).
        //
        // "New from template…" is gated on useHasTemplates — a live query
        // over drive_items. Even after the row exists server-side it reaches
        // the already-mounted query only on the next realtime redelivery, so
        // the item can render a beat after the menu first opens. Re-open the
        // menu until the reactive query has observed the template and the
        // item renders (instead of spending the whole 30s budget on a single
        // open that fired one tick too early — the pre-existing flake), then
        // click it.
        await openFileMenuWithTemplates(page)
        await page.getByRole('menuitem', { name: 'New from template…' }).click()

        const dialog = page.getByTestId('template-picker-dialog')
        await expect(dialog).toBeVisible()

        // The just-exported template appears by its friendly (stripped)
        // name. Pick it.
        const row = dialog.getByLabel(`Create from template: ${templateLabel}`)
        await expect(row).toBeVisible()
        await row.click()

        // A new document opens; its content includes the marker we typed
        // before exporting — proving the force-flush captured the live edit
        // into the template, not just the last debounced save.
        //
        // Scope to `.last()`: the app shell keeps the prior doc's screen
        // mounted (freezeOnBlur), so two .ProseMirror editors briefly
        // coexist after the in-app navigation — the new doc's editor is the
        // DOM-later one. A bare editorRoot() would trip Playwright strict
        // mode on the two matches.
        await page.waitForURL(/\/text\/[^/]+/)
        const newEditor = editorRoot(page).last()
        await expect(newEditor).toBeVisible()
        await expect(newEditor).toContainText(FRESH_MARKER)
    })
})

// Note: the "New from template…" entry points (File menu + index trigger)
// are hidden until the org has at least one `.tmpl.docx`, so the
// round-trip test above is what exercises the visible path — after it
// exports a template, the menu item appears and opens the picker. The
// hidden-when-empty behavior is covered deterministically by the
// useHasTemplates unit test (the shared e2e DB can't guarantee a
// template-free org once another test has exported one).

// Opens the File menu and waits for its "New from template…" item, which
// useHasTemplates renders only once its mounted drive_items live query has
// observed the just-exported `.tmpl.docx`. The row exists by now (the caller
// waited on it), but it reaches that persistently-mounted query only on the
// next realtime redelivery — which can land a beat after the menu first
// opens. Re-opening the menu each poll re-renders the popover against the
// freshest query result, so the item shows the moment the query catches up
// instead of the first open winning or losing the whole wait. Escape closes
// the menu between attempts so each openMenubarMenu is a clean open, not a
// toggle-shut of an already-open menu.
async function openFileMenuWithTemplates(page: Page): Promise<void> {
    const item = page.getByRole('menuitem', { name: 'New from template…' })
    await expect(async () => {
        await page.keyboard.press('Escape')
        await openMenubarMenu(page, 'File')
        await expect(item).toBeVisible({ timeout: 1_000 })
    }).toPass({ timeout: 20_000 })
}

// Runs File → Export as template…, confirms the folder dialog, and
// returns the label the picker will show for the new template — i.e. the
// document's name with its `.docx` extension stripped (templateDisplayName
// strips the full `.tmpl.docx` from `<name>.tmpl.docx`, which is `<name>`).
async function exportAsTemplate(page: Page): Promise<string> {
    // The title Pressable carries accessibilityLabel
    // "Rename document, currently <name>.docx"; pull the name from it so we
    // don't depend on the exact rendered title markup.
    const titleLabel =
        (await page
            .getByRole('button', { name: /^Rename document, currently / })
            .first()
            .getAttribute('aria-label')) ?? ''
    const docName = titleLabel.replace(/^Rename document, currently /, '').trim()
    const label = docName.replace(/\.docx$/i, '')

    await openMenubarMenu(page, 'File')
    await page.getByRole('menuitem', { name: 'Export as template…' }).click()

    // Export reuses drive's ChooseFolderDialog, titled `Save template
    // "<name>" to`. The confirm control is a RN Pressable (renders as a
    // generic, not a button role), so target its label text scoped to the
    // dialog. Confirm at the default folder (My Files / root).
    const dialog = page.getByTestId('choose-folder-dialog')
    await expect(dialog.getByText(/Save template ".*" to/)).toBeVisible()
    await dialog.getByText('Save template', { exact: true }).click()

    return label
}
