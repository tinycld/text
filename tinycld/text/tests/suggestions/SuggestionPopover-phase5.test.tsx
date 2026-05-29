import { describe, expect, it } from 'vitest'
import { summarizeSuggestionEntry } from '~/tinycld/text/lib/suggestions/popover-summary'

// Phase 5 Task 16 — the suggestion popover surfaces a human-readable
// summary line for each of the new kinds (format-change /
// block-change / cell-change) so the viewer knows what's being
// proposed without having to open the drawer.
//
// These tests pin the pure helper that produces the summary string;
// it's shared between the popover (SuggestionPopover.tsx) and the
// drawer row (SuggestionRow.tsx) so a single set of tests locks the
// wording for both surfaces. We test the helper directly rather than
// mounting the React component because <SuggestionPopover /> imports
// @tinycld/core/ui/button → @gluestack-ui, whose ESM bundle uses
// Flow-style `typeof` syntax that Vite can't parse in the node test
// environment. The component-level rendering of the same string is
// covered by the higher-level Playwright suite.

describe('summarizeSuggestionEntry (Phase 5 — popover/drawer summary)', () => {
    it('returns null for insert (Phase 2 look preserved — no Proposed: line)', () => {
        expect(
            summarizeSuggestionEntry({
                id: 's1',
                authorId: 'uo_a',
                kind: 'insert',
            })
        ).toBeNull()
    })

    it('returns null for delete (Phase 2 look preserved)', () => {
        expect(
            summarizeSuggestionEntry({
                id: 's1',
                authorId: 'uo_a',
                kind: 'delete',
            })
        ).toBeNull()
    })

    it('format-change with after.bold renders "Proposed: add bold"', () => {
        expect(
            summarizeSuggestionEntry({
                id: 's-fmt',
                authorId: 'uo_a',
                kind: 'format-change',
                beforeMarks: [],
                afterMarks: [{ type: 'bold' }],
            })
        ).toBe('Proposed: add bold')
    })

    it('format-change with attr delta renders "Proposed: change <type>"', () => {
        expect(
            summarizeSuggestionEntry({
                id: 's-fmt',
                authorId: 'uo_a',
                kind: 'format-change',
                beforeMarks: [{ type: 'textColor', attrs: { color: 'red' } }],
                afterMarks: [{ type: 'textColor', attrs: { color: 'blue' } }],
            })
        ).toBe('Proposed: change color')
    })

    it('block-change type swap to heading 2 renders "Proposed: change to heading 2"', () => {
        expect(
            summarizeSuggestionEntry({
                id: 's-blk',
                authorId: 'uo_a',
                kind: 'block-change',
                beforeBlock: { type: 'paragraph', attrs: {} },
                afterBlock: { type: 'heading', attrs: { level: 2 } },
            })
        ).toBe('Proposed: change to heading 2')
    })

    it('block-change delete renders "Proposed: delete paragraph"', () => {
        expect(
            summarizeSuggestionEntry({
                id: 's-blk-del',
                authorId: 'uo_a',
                kind: 'block-change',
                beforeBlock: { type: 'paragraph', attrs: {} },
                afterBlock: { type: 'paragraph', attrs: {}, deleted: true },
            })
        ).toBe('Proposed: delete paragraph')
    })

    it('cell-change add renders "Proposed: add cell"', () => {
        expect(
            summarizeSuggestionEntry({
                id: 's-cell-add',
                authorId: 'uo_a',
                kind: 'cell-change',
                beforeBlock: { type: 'tableCell', attrs: {}, added: true },
                afterBlock: { type: 'tableCell', attrs: {} },
            })
        ).toBe('Proposed: add cell')
    })

    it('cell-change delete renders "Proposed: delete cell"', () => {
        expect(
            summarizeSuggestionEntry({
                id: 's-cell-del',
                authorId: 'uo_a',
                kind: 'cell-change',
                beforeBlock: { type: 'tableCell', attrs: {} },
                afterBlock: { type: 'tableCell', attrs: {}, deleted: true },
            })
        ).toBe('Proposed: delete cell')
    })

    it('cell-change attr change renders "Proposed: <attr label>: <value>"', () => {
        // setCellAttribute proposals carry a colspan/rowspan change.
        // The block-attr label table renames colspan → "column span".
        expect(
            summarizeSuggestionEntry({
                id: 's-cell-attr',
                authorId: 'uo_a',
                kind: 'cell-change',
                beforeBlock: { type: 'tableCell', attrs: { colspan: 1 } },
                afterBlock: { type: 'tableCell', attrs: { colspan: 2 } },
            })
        ).toBe('Proposed: column span: 2')
    })

    it('block-change with missing before/after returns null (defensive)', () => {
        // A misconfigured entry without before/after shouldn't crash
        // the popover; we drop the summary line and the buttons still
        // render in the host component.
        expect(
            summarizeSuggestionEntry({
                id: 's-blk-broken',
                authorId: 'uo_a',
                kind: 'block-change',
            })
        ).toBeNull()
    })
})
