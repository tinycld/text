// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// SuggestionRow resolves the author user_org id to a human name via
// useAuthorName (pbtsdb live-query). The hook needs the react-provider
// tree wrapped via createReactProvider, which unit renders don't set
// up — stub it so the component falls back to rendering the raw
// authorId, which every assertion in this file pins.
vi.mock('~/tinycld/text/hooks/use-author-name', () => ({
    useAuthorName: () => null,
}))

// The focused-state body renders <SuggestionThread />, whose composer
// pulls the current user_org id from useEditorMount. Stub it so
// standalone renders work without an EditorMount provider.
vi.mock('@tinycld/core/lib/editor/editor-mount', () => ({
    useEditorMount: () => ({ identity: { userOrgId: 'uo_me' } }),
}))
vi.mock('~/tinycld/text/hooks/use-mention-suggestions', () => ({
    useMentionSuggestions: () => [],
}))

// The shared CommentComposer pulled in by SuggestionReplyComposer
// renders a TipTap-backed mention input; stub it so the focused-state
// renders deterministically in happy-dom without a live editor.
vi.mock('@tinycld/core/ui/comments', () => ({
    CommentComposer: () => null,
}))

// The focused-state thread subscribes to useSuggestionDiscussion (which
// talks to PocketBase). Stub it so a focused row renders without a live
// pbtsdb store.
vi.mock('~/tinycld/text/lib/suggestions/discussions', () => ({
    useSuggestionDiscussion: () => ({
        replies: [],
        addReply: async () => {},
        isLoading: false,
    }),
}))

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

function renderRow(
    suggestion: AnchoredSuggestion,
    overrides: { isFocused?: boolean; onFocus?: () => void; onJump?: () => void } = {}
) {
    return render(
        <SuggestionRow
            suggestion={suggestion}
            driveItemId="di_test"
            authorUserOrgId="uo_me"
            isFocused={overrides.isFocused ?? false}
            canResolve
            isPending={false}
            onAccept={NOOP}
            onReject={NOOP}
            onFocus={overrides.onFocus ?? NOOP}
            onJump={overrides.onJump}
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

// Phase 5 Task 4 — SuggestionRow no longer renders Accept/Reject buttons
// itself; those moved into <SuggestionThread />, which only mounts when
// the row is focused. Tapping the row's header calls onFocus, and the
// header reflects the focused state with the accent background.
describe('SuggestionRow (Task 4 — focus + header behavior)', () => {
    afterEach(() => cleanup())

    it('does not render Accept/Reject buttons in the unfocused header', () => {
        const { container } = renderRow(row({}), { isFocused: false })
        // Accept/Reject are now owned by <SuggestionThread />, which
        // only mounts when isFocused === true. With isFocused=false
        // neither button should appear anywhere in the row's DOM.
        expect(container.querySelector('[accessibilitylabel="Accept suggestion"]')).toBeNull()
        expect(container.querySelector('[accessibilitylabel="Reject suggestion"]')).toBeNull()
    })

    it('renders the suggestion-thread body when isFocused is true', () => {
        const { container } = renderRow(row({}), { isFocused: true })
        // The thread component carries data-testid="suggestion-thread"
        // (see SuggestionThread.tsx). Its presence signals that the
        // focused-state body mounted.
        expect(container.querySelector('[data-testid="suggestion-thread"]')).toBeTruthy()
    })

    it('wires onFocus to the header Pressable onPress', () => {
        // React Native's Pressable renders as a `<pressable>` string
        // element in happy-dom (per the react-native-stub), with
        // `onPress` passed through as a lowercase `onpress` prop.
        // testing-library's fireEvent.click doesn't translate to RN's
        // onPress, so instead of driving a synthetic click we assert
        // the prop is wired by reading react's internal fiber. The
        // SuggestionRow contract is just "onFocus is the Pressable's
        // primary press handler" — verifying the prop wiring covers
        // it for unit-test purposes; e2e specs exercise the real
        // click path in a real browser.
        const onFocus = vi.fn()
        const { container } = renderRow(row({}), { onFocus })
        const header = container.querySelector(
            '[accessibilitylabel="Suggestion by uo_alice"]'
        ) as HTMLElement | null
        expect(header).toBeTruthy()
        // The string-element Pressable's onPress comes through as the
        // `onpress` attribute on the DOM node when React serializes
        // unknown props on a host element. Verify it points at our
        // onFocus callback (React encodes function props as `function`
        // attributes whose presence we can detect).
        const propsKey = Object.keys(header ?? {}).find(k => k.startsWith('__reactProps$')) as
            | keyof HTMLElement
            | undefined
        expect(propsKey).toBeTruthy()
        const reactProps = propsKey
            ? ((header as unknown as Record<string, { onPress?: () => void }>)[propsKey] ?? null)
            : null
        expect(reactProps?.onPress).toBe(onFocus)
    })

    it('calls onJump once when isFocused transitions from false to true', () => {
        const onJump = vi.fn()
        const onFocus = vi.fn()
        const { rerender } = renderRow(row({}), { isFocused: false, onFocus, onJump })
        // Initial render with isFocused=false should not fire onJump.
        expect(onJump).not.toHaveBeenCalled()
        // Re-render with isFocused=true — onJump should fire once for
        // the edge transition.
        rerender(
            <SuggestionRow
                suggestion={row({})}
                driveItemId="di_test"
                authorUserOrgId="uo_me"
                isFocused
                canResolve
                isPending={false}
                onAccept={NOOP}
                onReject={NOOP}
                onFocus={onFocus}
                onJump={onJump}
            />
        )
        expect(onJump).toHaveBeenCalledTimes(1)
        // Re-render again still focused — onJump should not fire again.
        rerender(
            <SuggestionRow
                suggestion={row({})}
                driveItemId="di_test"
                authorUserOrgId="uo_me"
                isFocused
                canResolve
                isPending={false}
                onAccept={NOOP}
                onReject={NOOP}
                onFocus={onFocus}
                onJump={onJump}
            />
        )
        expect(onJump).toHaveBeenCalledTimes(1)
    })

    it('renders the author name + relative timestamp in the header', () => {
        // ts=Date.now() puts the row in the "just now" bucket.
        renderRow(row({ ts: Date.now() }))
        // Two text occurrences: in the name row and in the "Added by"
        // attribution line. getAllByText avoids ambiguity.
        expect(screen.getAllByText(/uo_alice/).length).toBeGreaterThan(0)
        expect(screen.getByText(/just now/)).toBeTruthy()
    })
})
