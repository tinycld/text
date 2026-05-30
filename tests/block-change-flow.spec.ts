import { expect, test } from '@playwright/test'
import {
    editorRoot,
    openFreshTextDocument,
    TEXT_TEST_TIMEOUT,
    waitForEditor,
} from './_menubar-helpers'

// End-to-end flow for a block-change suggestion (Phase 5 kind):
// in Suggesting mode, applying a heading transform to a paragraph
// produces a suggestedBlockChange attribute on the block node (the
// command layer reverts the structural setBlockType so the doc still
// renders the original <p>), the drawer's row carries the
// "Proposed: change to heading 2" summary, and accepting the row
// transforms the paragraph into the proposed <h2>.
//
// summarizeBlockChange in decorations.ts composes the
// "Proposed: change to heading 2" string for a paragraph→heading-2
// transform; the drawer's SuggestionRow reuses that summary via
// summarizeSuggestionEntry. The unit tests pin the helper output and
// the resolver behavior; this e2e proves the helper's output lands in
// the drawer row a real user sees and that Accept actually transforms
// the block.

test.describe('Text — Block-change flow', () => {
    test.setTimeout(TEXT_TEST_TIMEOUT)

    test('toggle heading in Suggesting → drawer summary → accept transforms block', async ({
        page,
    }) => {
        await openFreshTextDocument(page, 'block-change-flow')
        await editorRoot(page).click()
        await waitForEditor(page)

        // Insert a fresh paragraph at end of doc through the editor's
        // command chain. Using the dev hook (over keyboard shortcuts)
        // sidesteps the ⌘+End behavior gap on Mac (OS-level binding
        // can preempt Tiptap) and lets us deterministically place the
        // caret inside a paragraph we own.
        const phrase = `become a heading ${Date.now()}`
        await page.evaluate(text => {
            const w = window as unknown as {
                __tinyTextEditor?: {
                    chain: () => {
                        focus: (pos?: 'start' | 'end') => {
                            insertContent: (s: object | string) => { run: () => void }
                        }
                    }
                }
            }
            const e = w.__tinyTextEditor
            if (!e) return
            // Insert as a paragraph node so the block-change target
            // (the parent paragraph) is uniquely identifiable in the
            // post-typing doc.
            e.chain()
                .focus('end')
                .insertContent({
                    type: 'paragraph',
                    content: [{ type: 'text', text }],
                })
                .run()
        }, phrase)
        await expect(page.getByText(phrase)).toBeVisible({ timeout: 10_000 })

        // Switch into Suggesting mode via the toolbar dropdown.
        await page.getByRole('button', { name: 'Editor mode' }).click()
        await page.getByRole('menuitem', { name: 'Suggesting' }).click()
        await expect(page.locator('[data-current-mode="suggesting"]')).toBeVisible({
            timeout: 10_000,
        })

        // Place the caret inside the phrase's paragraph. setBlockType
        // (used by toggleHeading) operates on the block containing
        // the selection, so we set a collapsed selection inside the
        // phrase.
        await page.evaluate(text => {
            const w = window as unknown as {
                __tinyTextEditor?: {
                    state: {
                        doc: {
                            descendants: (
                                cb: (n: { isText?: boolean; text?: string }, pos: number) => void
                            ) => void
                        }
                    }
                    chain: () => {
                        focus: () => {
                            setTextSelection: (range: { from: number; to: number }) => {
                                run: () => void
                            }
                        }
                    }
                }
            }
            const e = w.__tinyTextEditor
            if (!e) return
            let from = -1
            e.state.doc.descendants((node, pos) => {
                if (!node.isText || !node.text) return
                const idx = node.text.indexOf(text)
                if (idx >= 0 && from < 0) {
                    from = pos + idx + 1
                }
            })
            if (from < 0) return
            e.chain().focus().setTextSelection({ from, to: from }).run()
        }, phrase)

        // Toggle the paragraph into a heading 2 via the toolbar's
        // "Heading 2" button (accessibilityLabel from DocumentToolbar).
        // The command layer's appendTransaction detects the
        // setNodeMarkup step (paragraph → heading), reverts the
        // structural change, and stamps a suggestedBlockChange
        // attribute on the (still paragraph) block with before={
        // type: 'paragraph', attrs: {} } and after={ type: 'heading',
        // attrs: { level: 2 } }.
        await page.getByRole('button', { name: 'Heading 2' }).first().click()

        // The schema renders the suggestedBlockChange attribute via
        // its renderHTML as data-block-change (the global attribute's
        // renderHTML serializes the payload as a URL-encoded JSON
        // string on the block element). Wait for the attribute to
        // land on some paragraph in the doc.
        await expect(page.locator('p[data-block-change]').first()).toBeVisible({
            timeout: 10_000,
        })

        // The phrase still lives inside a <p>, NOT an <h2> — the
        // command layer reverted the user's setBlockType, so the
        // structural change isn't applied yet. Pin that the phrase
        // hasn't pre-emptively become a heading.
        await expect(page.locator(`h2:has-text("${phrase}")`)).toHaveCount(0)

        // Open the drawer.
        await page.getByRole('button', { name: 'Open suggestion review drawer' }).click()
        await expect(page.getByText('Suggestions').first()).toBeVisible({ timeout: 5_000 })

        // The row's "Proposed:" line is composed by
        // summarizeSuggestionEntry → summarizeBlockChange. With a
        // paragraph→heading-2 swap the summary reads "Proposed:
        // change to heading 2" (BLOCK_TYPE_LABELS maps heading +
        // level=2 to "heading 2"; the level isn't repeated as a
        // separate attr fragment).
        await expect(page.getByText(/Proposed:.*change to heading 2/i).first()).toBeVisible({
            timeout: 10_000,
        })

        // Switch back to Editing mode BEFORE clicking Accept. Same
        // discipline as the format-change spec: the resolver's
        // setNodeMarkup step would otherwise be re-intercepted by the
        // command layer while in Suggesting mode and re-stamped as
        // another block-change.
        await page.getByRole('button', { name: 'Editor mode' }).click()
        await page.getByRole('menuitem', { name: 'Editing' }).click()
        await expect(page.locator('[data-current-mode="editing"]')).toBeVisible({ timeout: 5_000 })

        // Click Accept all to resolve the block-change row. The
        // resolver runs setNodeMarkup(pos, headingType, {level:2}) on
        // the affected block, clears the suggestedBlockChange wrapper
        // attribute, and flips the Y.Map status to 'accepted'.
        await page.getByRole('button', { name: 'Accept all suggestions' }).click()

        // The block transforms into an <h2> containing the phrase. The
        // schema renders heading nodes as <h{level}>, so the phrase
        // now lives inside an <h2>.
        await expect(page.locator(`h2:has-text("${phrase}")`)).toBeVisible({
            timeout: 10_000,
        })
    })
})
