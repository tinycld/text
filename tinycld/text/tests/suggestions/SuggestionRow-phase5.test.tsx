// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SuggestionRow } from '~/tinycld/text/components/suggestions/SuggestionRow'
import type { AnchoredSuggestion } from '~/tinycld/text/hooks/use-document-suggestions'

// Phase 5 Task 16 — SuggestionRow renders the new "Proposed: …"
// summary line for Phase 5 kinds beneath the snippet. Each test
// mounts the row with one kind and asserts the summary copy.

const NOOP = () => {}

function row(extra: Partial<AnchoredSuggestion>): AnchoredSuggestion {
    return {
        id: 's1',
        status: 'open',
        authorId: 'uo_alice',
        ts: 1000,
        kind: 'insert',
        anchorRange: { from: 1, to: 5 },
        snippet: 'snippet',
        ...extra,
    } as AnchoredSuggestion
}

function renderRow(suggestion: AnchoredSuggestion) {
    return render(
        <SuggestionRow
            suggestion={suggestion}
            isFocused={false}
            canResolve
            isPending={false}
            onAccept={NOOP}
            onReject={NOOP}
            onJump={NOOP}
        />
    )
}

describe('SuggestionRow (Phase 5 — format/block/cell summaries)', () => {
    afterEach(() => cleanup())

    it('format-change row renders a "Proposed: add bold" summary', () => {
        renderRow(
            row({
                kind: 'format-change',
                beforeMarks: [],
                afterMarks: [{ type: 'bold' }],
            })
        )
        expect(screen.getByText(/Proposed: add bold/)).toBeTruthy()
        // Attribution line uses the kind label, not "Added".
        expect(screen.getByText(/Format change by uo_alice/)).toBeTruthy()
    })

    it('block-change row renders a "Proposed: change to heading 2" summary', () => {
        renderRow(
            row({
                kind: 'block-change',
                beforeBlock: { type: 'paragraph', attrs: {} },
                afterBlock: { type: 'heading', attrs: { level: 2 } },
            })
        )
        expect(screen.getByText(/Proposed: change to heading 2/)).toBeTruthy()
        expect(screen.getByText(/Block change by uo_alice/)).toBeTruthy()
    })

    it('block-change delete row renders a "Proposed: delete paragraph" summary', () => {
        renderRow(
            row({
                kind: 'block-change',
                beforeBlock: { type: 'paragraph', attrs: {} },
                afterBlock: { type: 'paragraph', attrs: {}, deleted: true },
            })
        )
        expect(screen.getByText(/Proposed: delete paragraph/)).toBeTruthy()
    })

    it('cell-change add row renders a "Proposed: add cell" summary', () => {
        renderRow(
            row({
                kind: 'cell-change',
                snippet: 'Cell',
                beforeBlock: { type: 'tableCell', attrs: {}, added: true },
                afterBlock: { type: 'tableCell', attrs: {} },
            })
        )
        expect(screen.getByText(/Proposed: add cell/)).toBeTruthy()
        expect(screen.getByText(/Cell change by uo_alice/)).toBeTruthy()
    })

    it('cell-change delete row renders a "Proposed: delete cell" summary', () => {
        renderRow(
            row({
                kind: 'cell-change',
                snippet: 'Cell',
                beforeBlock: { type: 'tableCell', attrs: {} },
                afterBlock: { type: 'tableCell', attrs: {}, deleted: true },
            })
        )
        expect(screen.getByText(/Proposed: delete cell/)).toBeTruthy()
    })

    it('insert row preserves Phase 2 look — no "Proposed:" line, "Added by …"', () => {
        renderRow(row({ kind: 'insert', snippet: 'new text' }))
        expect(screen.queryByText(/Proposed:/)).toBeNull()
        expect(screen.getByText(/Added by uo_alice/)).toBeTruthy()
    })

    it('delete row preserves Phase 2 look — no "Proposed:" line, "Removed by …"', () => {
        renderRow(row({ kind: 'delete', snippet: 'to remove' }))
        expect(screen.queryByText(/Proposed:/)).toBeNull()
        expect(screen.getByText(/Removed by uo_alice/)).toBeTruthy()
    })
})
