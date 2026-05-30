// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// useAuthorName makes a pbtsdb live-query call that needs the
// createReactProvider wrapper. Stub it so the row falls back to
// rendering the raw user_org id. Each test then pins assertions
// against those raw ids — keeps the test free of provider setup.
vi.mock('~/tinycld/text/hooks/use-author-name', () => ({
    useAuthorName: () => null,
}))

import { SuggestionReplyList } from '~/tinycld/text/components/suggestions/SuggestionReplyList'
import type { SuggestionReply } from '~/tinycld/text/lib/suggestions/discussions'

function reply(extra: Partial<SuggestionReply>): SuggestionReply {
    return {
        id: 'r1',
        suggestionId: 's1',
        authorId: 'uo_alice',
        body: 'looks good',
        createdAt: Date.now() - 60_000,
        mentions: [],
        ...extra,
    }
}

describe('SuggestionReplyList', () => {
    afterEach(() => cleanup())

    it('renders nothing for an empty list', () => {
        const { container } = render(<SuggestionReplyList replies={[]} />)
        // Empty list intentionally renders null so the composer can
        // own the empty-state messaging — verify no DOM was emitted.
        expect(container.firstChild).toBeNull()
    })

    it('renders one row per reply with the author id and a relative timestamp', () => {
        const replies: SuggestionReply[] = [
            reply({
                id: 'r1',
                authorId: 'uo_alice',
                body: 'first',
                createdAt: Date.now() - 60_000,
            }),
            reply({
                id: 'r2',
                authorId: 'uo_bob',
                body: 'second',
                createdAt: Date.now() - 3600_000,
            }),
        ]
        render(<SuggestionReplyList replies={replies} />)

        // Author ids appear in two flavors — the avatar initials chip
        // and the inline author name (useAuthorName returns null, so
        // SuggestionReplyList falls back to the raw id). Use
        // getAllByText so both row variants are checked at once.
        expect(screen.getAllByText('uo_alice').length).toBeGreaterThan(0)
        expect(screen.getAllByText('uo_bob').length).toBeGreaterThan(0)
        expect(screen.getByText('first')).toBeTruthy()
        expect(screen.getByText('second')).toBeTruthy()
        // The minute-bucket renders the "1 minute ago" string for a
        // ~60s old reply and "1 hour ago" for the hour-old one.
        expect(screen.getByText('1 minute ago')).toBeTruthy()
        expect(screen.getByText('1 hour ago')).toBeTruthy()
    })
})
