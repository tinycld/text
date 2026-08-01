// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// useAuthorName issues a pbtsdb live-query that needs the react-provider
// wrapper. Stub it so rows fall back to the raw user_org id and the
// assertions can pin against that.
vi.mock('~/tinycld/text/hooks/use-author-name', () => ({
    useAuthorName: () => null,
}))

// The composer pulls the current user_org id from useEditorMount;
// stub it so the standalone render works without an EditorMount
// provider.
vi.mock('@tinycld/core/lib/editor/editor-mount', () => ({
    useEditorMount: () => ({ identity: { userId: 'user_me' } }),
}))
vi.mock('~/tinycld/text/hooks/use-mention-suggestions', () => ({
    useMentionSuggestions: () => [],
}))

// The composer also renders the shared CommentComposer. Stub it to
// expose its onSubmit prop so the test can drive a reply directly
// without an interactive form. Captured globally so each test can read it.
let composerOnSubmit: ((body: string) => void) | null = null
vi.mock('@tinycld/core/ui/comments', () => ({
    CommentComposer: (props: { onSubmit: (body: string) => void }) => {
        composerOnSubmit = props.onSubmit
        return null
    },
}))

// The thread subscribes to useSuggestionDiscussion for replies + the
// addReply mutator. Replace it with a deterministic stub keyed off
// module-scoped state — each test seeds the replies array and a fresh
// addReply spy before rendering.
let stubReplies: Array<{
    id: string
    suggestionId: string
    authorId: string
    body: string
    createdAt: number
    mentions: string[]
}> = []
const addReplySpy = vi.fn((body: string, mentions: string[]) => {
    void body
    void mentions
    return Promise.resolve()
})

vi.mock('~/tinycld/text/lib/suggestions/discussions', () => ({
    useSuggestionDiscussion: () => ({
        replies: stubReplies,
        addReply: addReplySpy,
        isLoading: false,
    }),
}))

import { SuggestionThread } from '~/tinycld/text/components/suggestions/SuggestionThread'
import type { AnchoredSuggestion } from '~/tinycld/text/hooks/use-document-suggestions'

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

describe('SuggestionThread', () => {
    afterEach(() => cleanup())

    beforeEach(() => {
        stubReplies = []
        composerOnSubmit = null
        addReplySpy.mockClear()
    })

    it('renders the data-testid root and the per-kind summary line', () => {
        render(
            <SuggestionThread
                suggestion={row({ kind: 'insert', snippet: 'new text' })}
                driveItemId="di_doc"
                authorUserId="uo_me"
                canResolve
                onAccept={NOOP}
                onReject={NOOP}
            />
        )
        // The e2e spec scopes assertions via this testid; locking it
        // here keeps the contract intact even if the rendering shape
        // shifts in future passes.
        expect(document.querySelector('[data-testid="suggestion-thread"]')).toBeTruthy()
        // Insert kind summary uses the "Add: '<snippet>'" template.
        expect(screen.getByText(/Add: 'new text'/)).toBeTruthy()
    })

    it("delete kind renders the Delete: '<snippet>' summary", () => {
        render(
            <SuggestionThread
                suggestion={row({ kind: 'delete', snippet: 'to remove' })}
                driveItemId="di_doc"
                authorUserId="uo_me"
                canResolve
                onAccept={NOOP}
                onReject={NOOP}
            />
        )
        expect(screen.getByText(/Delete: 'to remove'/)).toBeTruthy()
    })

    it('shows the Accept/Reject icon buttons when canResolve is true', () => {
        // The buttons render as `<pressable accessibilitylabel="…">`
        // lowercase custom elements in happy-dom — React Native's
        // Pressable doesn't map onPress to a DOM `onclick` against a
        // string-typed tag, so we can't drive a click programmatically.
        // The interactive Accept/Reject flow is already covered by the
        // higher-level ReviewDrawer test + the suggestion-thread e2e
        // spec (Task 7) which boots a real browser. Here we just
        // verify the buttons are present with the expected a11y labels.
        const { container } = render(
            <SuggestionThread
                suggestion={row({})}
                driveItemId="di_doc"
                authorUserId="uo_me"
                canResolve
                onAccept={NOOP}
                onReject={NOOP}
            />
        )
        expect(container.querySelector('[accessibilitylabel="Accept suggestion"]')).toBeTruthy()
        expect(container.querySelector('[accessibilitylabel="Reject suggestion"]')).toBeTruthy()
    })

    it('hides the Accept/Reject toolbar when canResolve is false', () => {
        const { container } = render(
            <SuggestionThread
                suggestion={row({})}
                driveItemId="di_doc"
                authorUserId="uo_me"
                canResolve={false}
                onAccept={NOOP}
                onReject={NOOP}
            />
        )
        expect(container.querySelector('[accessibilitylabel="Accept suggestion"]')).toBeNull()
        expect(container.querySelector('[accessibilitylabel="Reject suggestion"]')).toBeNull()
    })

    it('renders the reply list when the discussion adapter returns replies', () => {
        stubReplies = [
            {
                id: 'r1',
                suggestionId: 's1',
                authorId: 'uo_alice',
                body: 'first reply',
                createdAt: Date.now() - 60_000,
                mentions: [],
            },
            {
                id: 'r2',
                suggestionId: 's1',
                authorId: 'uo_bob',
                body: 'second reply',
                createdAt: Date.now() - 30_000,
                mentions: [],
            },
        ]
        render(
            <SuggestionThread
                suggestion={row({})}
                driveItemId="di_doc"
                authorUserId="uo_me"
                canResolve
                onAccept={NOOP}
                onReject={NOOP}
            />
        )
        expect(screen.getByText('first reply')).toBeTruthy()
        expect(screen.getByText('second reply')).toBeTruthy()
    })

    it('wires addReply through the composer onSubmit (body + mentions forwarded)', async () => {
        render(
            <SuggestionThread
                suggestion={row({})}
                driveItemId="di_doc"
                authorUserId="uo_me"
                canResolve
                onAccept={NOOP}
                onReject={NOOP}
            />
        )
        expect(composerOnSubmit).toBeTruthy()
        // Drive the inner CommentComposer's onSubmit; the
        // SuggestionReplyComposer wrapper parses the @-tokens out and
        // forwards (body, mentions[]) to the discussion adapter.
        await composerOnSubmit?.('thanks [[@uo_alice]]')
        expect(addReplySpy).toHaveBeenCalledWith('thanks [[@uo_alice]]', ['uo_alice'])
    })
})
