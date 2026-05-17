import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import {
    login,
    ORG_SLUG,
    TEST_USER_EMAIL,
    TEST_USER_PASSWORD,
} from '../../../../tests/e2e/helpers'

// Bootstrap (docx parse + Y.Doc seed + realtime SyncReply + Tiptap mount)
// can take ~30s under parallel-worker contention; mirror text-document.spec.ts.
const TEST_TIMEOUT = 120_000

const PB_URL = 'http://127.0.0.1:7200'

const DOCX_MIME =
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

const FEATURE_DOC_HEADING = 'Sample Document'

// Hex color the Heading 1 run carries in feature-test.docx. The translator
// reads <w:color w:val="C00000"> into a textStyle mark; TextStyle+Color
// extensions in the editor schema render this as `color: rgb(192, 0, 0)`
// on the inline <span>.
const HEADING1_RED_RGB = 'rgb(192, 0, 0)'

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

async function openFixture(page: Page): Promise<string> {
    // Drive's collection treats (org, parent, name) as unique; parallel
    // workers in the same millisecond would otherwise collide on Date.now().
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const itemId = await uploadDocxAsDriveItem(`fidelity-${unique}.docx`)
    await login(page)
    await page.goto(`/a/${ORG_SLUG}/text/${itemId}`)
    await expect(editorRoot(page)).toBeVisible({ timeout: 60_000 })
    // Bootstrap is asynchronous; the H1 lands once the Y.Doc has been
    // seeded and the Tiptap binding catches up.
    await expect(page.getByText(FEATURE_DOC_HEADING).first()).toBeVisible({
        timeout: 30_000,
    })
    return itemId
}

// domSnapshot reads what the user actually sees — rendered HTML in the
// editor, never ProseMirror's internal node tree. The point of the
// fidelity fixes is that the Word document round-trips through the
// import pipeline AND the Y.Doc bridge AND y-prosemirror AND the
// schema's renderHTML — assertions therefore have to live at the DOM
// level, since anything earlier in the chain could be silently dropped
// before the user sees it.
type DomSnapshot = {
    headings: { tag: string; text: string }[]
    orderedLists: { start: number; firstItem: string; itemTexts: string[] }[]
    sampleDocColors: string[]
    tables: {
        width: number
        firstHeaderTexts: string[]
        // Per-cell {colspan, rowspan, text} for every row, so a test
        // can check that the merged headers ("May 2012", "September 2010")
        // actually render with colspan=2 instead of collapsing to plain
        // 1-col cells. Reads HTMLTableCellElement.colSpan, which is
        // the *rendered* value the browser uses for layout — exactly
        // what determines whether the cell visually spans columns.
        cells: { colspan: number; rowspan: number; text: string }[][]
    }[]
    editorWidth: number
}
async function domSnapshot(page: Page): Promise<DomSnapshot> {
    return page.evaluate(() => {
        const pmDom = document.querySelector<HTMLElement>('.ProseMirror')
        if (!pmDom) throw new Error('no ProseMirror DOM found')

        const headings = Array.from(
            pmDom.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')
        ).map((h) => ({ tag: h.tagName, text: (h.textContent ?? '').slice(0, 80) }))

        // Only collect top-level (un-nested) ordered lists. The fixture's
        // structure puts both numbered runs at the same depth (the bullet
        // list lives between them but isn't a parent), so a list nested
        // inside another <li> is a different concept and shouldn't enter
        // the "did the outline list resume" assertion.
        const orderedLists = Array.from(pmDom.querySelectorAll<HTMLOListElement>('ol'))
            .filter((ol) => !ol.parentElement?.closest('li'))
            .map((ol) => {
                // `start` defaults to 1 when omitted (HTMLOListElement.start
                // exposes the effective value), so read the live property
                // — not getAttribute — to mirror what the browser renders.
                const items = Array.from(ol.querySelectorAll<HTMLLIElement>(':scope > li'))
                return {
                    start: ol.start,
                    firstItem: (items[0]?.textContent ?? '').trim().slice(0, 80),
                    itemTexts: items.map((li) => (li.textContent ?? '').trim().slice(0, 80)),
                }
            })

        // For "Sample Document" find every descendant element under its
        // heading whose text contains the title and read the COMPUTED
        // color the browser uses to paint it. TextStyle+Color renders as
        // a <span style="color: …">; if no inline span exists, falling
        // back to the heading's own computed color still gives us the
        // user-visible result.
        const sampleDocColors: string[] = []
        for (const h of Array.from(pmDom.querySelectorAll<HTMLElement>('h1, h2'))) {
            if (!(h.textContent ?? '').includes('Sample Document')) continue
            const spans = Array.from(h.querySelectorAll<HTMLElement>('*')).filter((n) =>
                (n.textContent ?? '').includes('Sample Document')
            )
            const sources = spans.length > 0 ? spans : [h]
            for (const node of sources) {
                sampleDocColors.push(window.getComputedStyle(node).color)
            }
            break
        }

        // Table rendered widths: TipTap's TableView writes inline
        // `style="width: Npx"` from the summed colwidth attributes,
        // and the import preserves the .docx column widths. Reading
        // the rendered offsetWidth captures exactly what the user
        // sees (regardless of how those widths got there).
        const tables = Array.from(pmDom.querySelectorAll<HTMLTableElement>('table')).map(
            (t) => {
                const headerRow = t.querySelector('tr')
                const headerTexts = headerRow
                    ? Array.from(headerRow.querySelectorAll<HTMLElement>('td, th')).map(
                          (c) => (c.textContent ?? '').trim().slice(0, 40)
                      )
                    : []
                const cells = Array.from(t.querySelectorAll<HTMLTableRowElement>('tr')).map(
                    (row) =>
                        Array.from(row.querySelectorAll<HTMLTableCellElement>('td, th')).map(
                            (c) => ({
                                colspan: c.colSpan,
                                rowspan: c.rowSpan,
                                text: (c.textContent ?? '').trim().slice(0, 40),
                            })
                        )
                )
                return { width: t.offsetWidth, firstHeaderTexts: headerTexts, cells }
            }
        )

        const editorWidth = pmDom.offsetWidth

        return { headings, orderedLists, sampleDocColors, tables, editorWidth }
    })
}

test.describe('Text — .docx fidelity', () => {
    test.setTimeout(TEST_TIMEOUT)

    test('heading levels render with the correct tag', async ({ page }) => {
        // Regression: prior to the yjs-bridge normalizeAttrValue fix,
        // every heading rendered as <h1> because the float64 `level`
        // value from JSON-decoded attrs was silently dropped by
        // y-crdt's TypeMapSet (which only accepts int, not float64),
        // so PM applied the schema default and y-prosemirror rendered
        // every heading at level 1.
        await openFixture(page)
        const { headings } = await domSnapshot(page)

        const byText = new Map(headings.map((h) => [h.text.trim(), h.tag]))
        expect(byText.get('Sample Document'), 'Sample Document should render as H1').toBe(
            'H1'
        )
        expect(byText.get('Headings')).toBe('H2')
        expect(byText.get('Lists')).toBe('H2')
        expect(byText.get('Links')).toBe('H2')
        expect(byText.get('Images')).toBe('H2')
        expect(byText.get('Tables')).toBe('H2')
        expect(byText.get('Simple Tables')).toBe('H3')
        expect(byText.get('Complex Tables')).toBe('H3')
        expect(byText.get('Columns')).toBe('H2')

        // Lock the per-tag counts to catch silent collapses of the
        // hierarchy (e.g. every heading becoming an H1 again).
        await expect(page.locator('.ProseMirror h1')).toHaveCount(1)
        await expect(page.locator('.ProseMirror h2')).toHaveCount(6)
        await expect(page.locator('.ProseMirror h3')).toHaveCount(2)
    })

    test('numbered list continues past the nested bullet break (Columns = 6)', async ({
        page,
    }) => {
        // The fixture's outline list is decimal 1–5 (Headings…Tables),
        // then a nested bulleted list (Simple/Complex Tables), then the
        // numbered list resumes at item 6 (Columns) — Word's natural
        // continuation behavior. We surface this on import by emitting
        // a `start` attribute on the resumed <ol>, and round-trip it on
        // export by reusing the same numId so re-import re-derives it.
        await openFixture(page)
        const { orderedLists } = await domSnapshot(page)

        const headingsList = orderedLists.find((l) => l.firstItem.startsWith('Headings'))
        const columnsList = orderedLists.find((l) => l.firstItem.startsWith('Columns'))

        expect(headingsList, 'expected a top-level <ol> starting with "Headings"').toBeTruthy()
        expect(columnsList, 'expected a top-level <ol> starting with "Columns"').toBeTruthy()
        expect(headingsList?.start, 'first list should start at 1').toBe(1)
        expect(columnsList?.start, 'resumed list should start at 6 to match Word').toBe(6)
        expect(headingsList?.itemTexts).toHaveLength(5)
        expect(columnsList?.itemTexts).toHaveLength(1)

        // The HTML `start` attribute is what an external reader (printer,
        // PDF, screen reader) would see — assert it is the literal "6"
        // string the browser rendered.
        const columnsOl = page.locator('.ProseMirror ol', {
            has: page.locator('li', { hasText: 'Columns' }),
        })
        await expect(columnsOl).toHaveAttribute('start', '6')
    })

    test('tables keep their .docx column widths instead of stretching to 100%', async ({
        page,
    }) => {
        // The fixture's simple table totals ~3.93 in worth of columns
        // (1617 + 1270 + 884 dxa, where 1 in = 1440 dxa). The complex
        // table totals ~6.57 in — practically the full width of a US
        // Letter page's usable area, so it should fill most of the
        // page-width-capped editor. Both widths come from the docx
        // pipeline (parser writes per-cell colwidth attrs, TipTap's
        // TableView sets table.style.width to the summed colwidths).
        await openFixture(page)
        const { tables, editorWidth } = await domSnapshot(page)

        expect(tables.length, 'expected both fixture tables to render').toBeGreaterThanOrEqual(
            2
        )
        const simple = tables.find((t) => t.firstHeaderTexts.includes('Screen Reader'))
        expect(simple, 'expected the "Screen Reader" simple table').toBeTruthy()
        // 3771 dxa ≈ 251 px at our 1-dxa-per-15-px conversion. Allow
        // a small TableView/cell-padding fudge factor on either side.
        expect(simple?.width).toBeGreaterThan(220)
        expect(simple?.width).toBeLessThan(320)
        // The simple table is genuinely narrow in Word — it should NOT
        // stretch to fill the page-width editor.
        expect(simple?.width, 'simple table should be narrower than the editor').toBeLessThan(
            editorWidth * 0.6
        )

        const complex = tables.find((t) => t.firstHeaderTexts.includes('May 2012'))
        expect(complex, 'expected the merged-header complex table').toBeTruthy()
        // 9461 dxa ≈ 631 px. Same fudge factor.
        expect(complex?.width).toBeGreaterThan(580)
        expect(complex?.width).toBeLessThan(700)
        // The complex table fills nearly the whole Word page; with the
        // editor capped to ~page width, it should also fill most of the
        // editor pane (the visual cue a Word user expects to see).
        expect(complex?.width, 'complex table should fill ≥85% of the editor').toBeGreaterThan(
            editorWidth * 0.85
        )
    })

    test('content area is capped at roughly a Word page width', async ({ page }) => {
        // We mirror Word's "Web Layout" feel by capping the editor's
        // content area at ~US Letter's usable width (8.5in - 2*1in
        // margins = 6.5in ≈ 624px at 96dpi, plus a small fudge factor).
        // Without this, a wide browser pane would render every imported
        // table tiny relative to surrounding whitespace.
        await openFixture(page)
        const { editorWidth } = await domSnapshot(page)
        // Allow 600–760 px (covers 624 page width + breathing room and
        // any wrapper padding). A failure here means the page-width cap
        // got removed or overridden by a parent rule.
        expect(editorWidth).toBeGreaterThan(600)
        expect(editorWidth).toBeLessThan(760)
    })

    test('merged-header cells render with colspan=2', async ({ page }) => {
        // The fixture's "Complex Tables" table has two header cells that
        // each span two physical columns in Word (<w:gridSpan w:val="2">):
        //   row 0: ['', 'May 2012' (gridSpan=2), 'September 2010' (gridSpan=2)]
        //   row 1: ['Screen Reader', 'Responses', 'Share', 'Responses', 'Share']
        //
        // The visual cue a Word user expects is "May 2012" and "September 2010"
        // stretching across both of the data columns they govern. If colspan
        // doesn't survive the import → Y.Doc → y-tiptap → ProseMirror schema
        // round-trip, those headers split into individual single-column
        // cells and the table reads like every header label has been
        // duplicated. That's the bug this test guards against.
        await openFixture(page)
        const { tables } = await domSnapshot(page)
        const complex = tables.find((t) => t.firstHeaderTexts.includes('May 2012'))
        expect(complex, 'expected the merged-header complex table').toBeTruthy()
        const row0 = complex?.cells[0] ?? []
        const may = row0.find((c) => c.text === 'May 2012')
        const sept = row0.find((c) => c.text.includes('September 2010'))
        expect(may, 'expected a "May 2012" cell in row 0').toBeTruthy()
        expect(sept, 'expected a "September 2010" cell in row 0').toBeTruthy()
        expect(may?.colspan, 'May 2012 header should span 2 columns').toBe(2)
        expect(sept?.colspan, 'September 2010 header should span 2 columns').toBe(2)
        // Row 1 should have 5 single-column cells — the unmerged header
        // row. Catches a regression where colspan leaks onto row 1 too.
        const row1 = complex?.cells[1] ?? []
        expect(row1.length, 'row 1 should have 5 cells').toBe(5)
        for (const c of row1) {
            expect(c.colspan, `row 1 cell "${c.text}" should be colspan=1`).toBe(1)
        }
    })

    test('Heading 1 renders with the .docx red color', async ({ page }) => {
        // The fixture's H1 run has <w:color w:val="C00000">. After
        // import the heading text should be painted #C00000 — whether
        // that color lands on an inline <span> from TextStyle+Color or
        // directly on the <h1> doesn't matter to the user, only the
        // computed color does.
        await openFixture(page)
        const { sampleDocColors } = await domSnapshot(page)
        expect(sampleDocColors.length, 'expected a colored Sample Document run').toBeGreaterThan(
            0
        )
        for (const c of sampleDocColors) {
            expect(c, 'Sample Document should paint as imported red').toBe(HEADING1_RED_RGB)
        }
    })

    test('left-wrapped image floats with text flowing to its right', async ({ page }) => {
        // Regression: when the resize NodeView landed, it wrapped the
        // <img> in two non-floating spans. The float-left CSS was still
        // on the inner <img>, but floats only push siblings of their
        // direct parent — so text dropped *below* the image instead of
        // wrapping. This test guards two invariants:
        //   1. The floated wrapper's box matches the rendered <img>'s
        //      box (no skew / no oversized outline).
        //   2. At least one text-run in the paragraph that contains the
        //      image sits to the right of it (i.e. text actually wraps).
        // Both invariants together fail under the regression even when
        // the underlying width/height attrs are correct.
        await openFixture(page)
        const layout = await page.evaluate(() => {
            const pmDom = document.querySelector<HTMLElement>('.ProseMirror')
            if (!pmDom) throw new Error('no ProseMirror DOM')
            const wrapper = pmDom.querySelector<HTMLElement>(
                '[data-node-view-wrapper][data-wrap="left"]'
            )
            if (!wrapper) return { found: false as const }
            const img = wrapper.querySelector<HTMLImageElement>('img')
            if (!img) throw new Error('wrapped image has no <img>')
            const wRect = wrapper.getBoundingClientRect()
            const iRect = img.getBoundingClientRect()
            const para = wrapper.closest('p')
            // Find a non-empty text node in the same paragraph and read
            // its first client rect. If text wrapping works, that rect's
            // left edge sits to the right of the image's right edge.
            let firstTextRectLeft: number | null = null
            if (para) {
                const walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT, null)
                let node = walker.nextNode()
                while (node) {
                    const text = (node.nodeValue ?? '').trim()
                    if (text.length > 0) {
                        const range = document.createRange()
                        range.selectNodeContents(node)
                        const r = range.getClientRects()[0]
                        if (r) {
                            firstTextRectLeft = r.left
                            break
                        }
                    }
                    node = walker.nextNode()
                }
            }
            return {
                found: true as const,
                wrapper: { width: wRect.width, height: wRect.height, right: wRect.right },
                img: { width: iRect.width, height: iRect.height, right: iRect.right },
                firstTextRectLeft,
            }
        })

        expect(layout.found, 'fixture should contain at least one left-wrapped image').toBe(
            true
        )
        if (!layout.found) return
        // The wrapper's box must match the rendered <img>'s box within a
        // sub-pixel rounding tolerance. Under the regression the wrapper
        // is sized to the committed attrs while the img is clamped by
        // a CSS max-width — width/height diverge by tens of pixels.
        expect(
            Math.abs(layout.wrapper.width - layout.img.width),
            'wrapper width should match img width (no max-width skew)'
        ).toBeLessThanOrEqual(1)
        expect(
            Math.abs(layout.wrapper.height - layout.img.height),
            'wrapper height should match img height (aspect ratio preserved)'
        ).toBeLessThanOrEqual(1)
        // Text wrap: a text run in the same paragraph must sit to the
        // right of the floated image. Under the regression the float
        // does not push the run, so its left edge would be at or near
        // the paragraph's left edge.
        expect(
            layout.firstTextRectLeft,
            'expected to find a text run in the image paragraph'
        ).not.toBeNull()
        if (layout.firstTextRectLeft !== null) {
            expect(
                layout.firstTextRectLeft,
                'text should flow to the right of the floated image'
            ).toBeGreaterThan(layout.img.right - 1)
        }
    })
})
