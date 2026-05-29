import { expect, test } from '@playwright/test'
import {
    editorRoot,
    openFreshTextDocument,
    TEXT_TEST_TIMEOUT,
    waitForEditor,
} from './_menubar-helpers'

// End-to-end flow for a format-change suggestion (Phase 5 kind):
// in Suggesting mode, toggling bold on a selection produces a
// suggestedFormatChange mark (the raw bold mark is reverted by the
// command layer, the underline-only decoration is the visual signal),
// the drawer's row carries the "Proposed: add bold" summary, and
// accepting the row removes the suggestion mark and applies the
// proposed bold to the text.
//
// summarizeFormatChange in decorations.ts composes the
// "Proposed: add bold" string from the before/after mark deltas;
// the drawer's SuggestionRow re-uses that summary via
// summarizeSuggestionEntry. The unit tests pin the helper output;
// this e2e proves the helper's output lands in the actual drawer
// row a real user sees.

test.describe('Text — Format-change flow', () => {
    test.setTimeout(TEXT_TEST_TIMEOUT)

    test('toggle bold in Suggesting → drawer summary → accept applies bold', async ({ page }) => {
        await openFreshTextDocument(page, 'format-change-flow')
        await editorRoot(page).click()
        await waitForEditor(page)

        // Type the marker phrase BEFORE switching modes. The text
        // lands as a regular paragraph run (no suggestion marks). We
        // then switch into Suggesting and toggle bold on this same
        // run, producing a SINGLE format-change suggestion (no insert
        // layered on top) — that isolates the format-change drawer row
        // from any insert noise.
        //
        // Use page.evaluate to drive the editor's chain commands
        // directly: focus end + insertContent. This avoids relying on
        // ⌘+End behavior (the OS-level binding can preempt Tiptap on
        // Mac, landing the caret at end-of-line rather than end-of-doc).
        const phrase = `apply bold to this ${Date.now()}`
        await page.evaluate(text => {
            const w = window as unknown as {
                __tinyTextEditor?: {
                    chain: () => {
                        focus: (pos?: 'start' | 'end') => {
                            insertContent: (s: string) => { run: () => void }
                        }
                    }
                }
            }
            // The screen exposes the live Tiptap editor via a dev hook
            // (useDevTiptapEditorWindowHook in screens/[id].tsx) so e2e
            // tests can drive commands deterministically. Falls back to
            // a no-op if the hook isn't installed; the assertion below
            // will then fail with a clearer message.
            const e = w.__tinyTextEditor
            if (!e) return
            e.chain().focus('end').insertContent(`\n${text}`).run()
        }, phrase)
        await expect(page.getByText(phrase)).toBeVisible({ timeout: 10_000 })

        // Switch into Suggesting mode via the toolbar dropdown.
        await page.getByRole('button', { name: 'Editor mode' }).click()
        await page.getByRole('menuitem', { name: 'Suggesting' }).click()
        await expect(page.getByLabel('Suggesting mode')).toBeVisible({ timeout: 10_000 })

        // Select the just-typed phrase via the editor's command chain
        // again. We use the dev hook because driving selection via the
        // page's keyboard with the menu portal still dismissing is
        // race-prone: a stray click that lands AFTER the menu closes
        // but BEFORE the editor refocuses lands the caret at the wrong
        // position and the subsequent select/toggle no-ops. The dev
        // hook is the same surface unit tests use, so we exercise the
        // same code path here.
        const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
        await page.evaluate(text => {
            const w = window as unknown as {
                __tinyTextEditor?: {
                    state: { doc: { textContent: string } }
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
            const idx = e.state.doc.textContent.lastIndexOf(text)
            if (idx < 0) return
            // textContent is 0-indexed across the doc's text runs; PM
            // positions are 1-indexed (every node entry consumes a
            // position). For a flat paragraph this is +1; for our
            // phrase appearing near end-of-doc we use a search-then-
            // map approach: find the doc range whose flat text matches
            // and select it. The descendants walk gives us the exact
            // PM positions.
            let from = -1
            let to = -1
            const doc = (
                e as unknown as {
                    state: {
                        doc: {
                            descendants: (
                                cb: (n: { isText?: boolean; text?: string }, pos: number) => void
                            ) => void
                        }
                    }
                }
            ).state.doc
            doc.descendants((node, pos) => {
                if (!node.isText || !node.text) return
                const found = node.text.indexOf(text)
                if (found >= 0 && from < 0) {
                    from = pos + found
                    to = from + text.length
                }
            })
            if (from < 0) return
            e.chain().focus().setTextSelection({ from, to }).run()
        }, phrase)

        // Toggle bold via keyboard (the menu portal is closed by now
        // and the editor has focus from the setTextSelection above).
        // The command layer reverts the user's bold toggle and stamps
        // a suggestedFormatChange mark over the range with
        // before=[]/after=[bold] snapshots.
        await page.keyboard.press(`${meta}+b`)
        await expect(page.locator('[data-suggested-format-change]').first()).toBeVisible({
            timeout: 10_000,
        })

        // The bold mark itself was REVERTED — the text does NOT
        // render as <strong>. Visual signal is the decoration's
        // colored underline, not the bold weight. Asserting absence
        // of <strong>-wrapped phrase pins that the suggestion didn't
        // accidentally land as a real bold.
        await expect(page.locator(`strong:has-text("${phrase}")`)).toHaveCount(0)

        // Open the drawer.
        await page.getByRole('button', { name: 'Open suggestion review drawer' }).click()
        await expect(page.getByText('Suggestions').first()).toBeVisible({ timeout: 5_000 })

        // The row's "Proposed:" line is composed by
        // summarizeSuggestionEntry → summarizeFormatChange. With only
        // a bold-add toggle in the diff, the summary is
        // "Proposed: add bold". Match flexibly: case-insensitive.
        await expect(page.getByText(/Proposed:.*add bold/i).first()).toBeVisible({
            timeout: 10_000,
        })

        // Switch back to Editing mode BEFORE clicking Accept. The
        // command layer's appendTransaction is gated on Suggesting
        // mode: while still in Suggesting, the resolver's
        // tr.addMark(bold) step gets intercepted and re-stamped as a
        // fresh format-change (the wrapper-remove step is filtered
        // out of the toggle scan, but the bold-add isn't). Switching
        // to Editing first lets the resolution's PM transaction land
        // directly. The unit tests for acceptSuggestion enforce the
        // same discipline — see tests/suggestions/format-change-resolve.test.ts:115.
        await page.getByRole('button', { name: 'Editor mode' }).click()
        await page.getByRole('menuitem', { name: 'Editing' }).click()
        await expect(page.getByLabel('Suggesting mode')).not.toBeVisible({ timeout: 5_000 })

        // Click Accept all to resolve the format-change row. The
        // resolver strips the suggestedFormatChange wrapper and
        // applies the before→after delta — for [] → [bold], the delta
        // is "add bold over the range".
        await page.getByRole('button', { name: 'Accept all suggestions' }).click()

        // Once resolved (and out of Suggesting mode), the bold mark IS
        // applied to the phrase's range. Inspect the live editor via
        // the dev hook because <strong> tag matching is brittle when
        // the phrase shares a paragraph with surrounding content (the
        // bold mark wraps only the suggestion's range, not the whole
        // text node).
        const hasBoldOnPhrase = await page.evaluate(text => {
            const w = window as unknown as {
                __tinyTextEditor?: {
                    state: {
                        doc: {
                            descendants: (
                                cb: (
                                    n: {
                                        isText?: boolean
                                        text?: string
                                        marks?: Array<{ type: { name: string } }>
                                    },
                                    pos: number
                                ) => void
                            ) => void
                        }
                    }
                }
            }
            const e = w.__tinyTextEditor
            if (!e) return false
            let found = false
            e.state.doc.descendants(node => {
                if (!node.isText || !node.text) return
                if (!node.text.includes(text)) return
                if ((node.marks ?? []).some(m => m.type.name === 'bold')) found = true
            })
            return found
        }, phrase)
        expect(hasBoldOnPhrase).toBe(true)
    })
})
