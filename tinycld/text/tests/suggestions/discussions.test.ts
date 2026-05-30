// @vitest-environment happy-dom
//
// Unit tests for useSuggestionDiscussion — the read+write adapter that
// surfaces text_comments rows tagged with a suggestion_id and writes
// new reply rows on submit. The hook composes three primitives:
//   1. `useStore('text_comments', 'comment_mentions')` for collections
//   2. `useOrgLiveQuery` for the read subscription
//   3. `useMutation` for the write path
//
// We mock all three so the tests don't need a live PocketBase. The
// mocks expose the spies the assertions read; happy-dom is set so
// renderHook from @testing-library/react can mount the hook.
//
// The mocked `useOrgLiveQuery` lets each test inject the rows it
// wants the hook to see. The mocked `useStore` returns spy
// `.insert()` methods so we can verify what addReply writes.

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Per-test storage the mocks read from / write to. Reset in beforeEach.
let commentRows: Array<{
    id: string
    suggestion_id: string
    author: string
    body: string
    created: string
    archived_at?: string | null
}> = []
let mentionRows: Array<{
    id: string
    comment_record: string
    drive_item: string
    mentioned_user_org: string
}> = []
let commentLoading = false
let mentionLoading = false

const textCommentsInsert = vi.fn((row: Record<string, unknown>) => ({
    isPersisted: { promise: Promise.resolve(row) },
}))
const commentMentionsInsert = vi.fn((row: Record<string, unknown>) => ({
    isPersisted: { promise: Promise.resolve(row) },
}))

vi.mock('@tinycld/core/lib/pocketbase', () => ({
    useStore: (...names: string[]) =>
        names.map(name => {
            if (name === 'text_comments') return { insert: textCommentsInsert }
            if (name === 'comment_mentions') return { insert: commentMentionsInsert }
            throw new Error(`unexpected useStore name: ${name}`)
        }),
}))

// The mock returns whichever dataset the test currently configured.
// We tell which subscription this call is for by introspecting the
// query function — the hook calls `.from({ comment: ... })` for
// text_comments and `.from({ mention: ... })` for comment_mentions.
// We don't actually execute the chain; we return the pre-staged data
// based on the key the call site uses (probed via a fake `from`).
vi.mock('@tinycld/core/lib/use-org-live-query', () => ({
    useOrgLiveQuery: (queryFn: (q: unknown) => unknown | null) => {
        let resolvedKind: 'comment' | 'mention' | null = null
        const fakeQuery = {
            from: (table: Record<string, unknown>) => {
                if (table.comment) resolvedKind = 'comment'
                if (table.mention) resolvedKind = 'mention'
                return {
                    where: () => ({
                        orderBy: () => ({}),
                    }),
                }
            },
        }
        // Short-circuit path: queryFn returns null when suggestionId
        // is null. Mirrors the real hook's behaviour.
        if (queryFn(fakeQuery) == null) {
            return { data: [], isLoading: false, isReady: true, status: 'ready' }
        }
        if (resolvedKind === 'comment') {
            return {
                data: commentRows.filter(r => r.archived_at == null),
                isLoading: commentLoading,
                isReady: !commentLoading,
                status: commentLoading ? 'loading' : 'ready',
            }
        }
        if (resolvedKind === 'mention') {
            return {
                data: mentionRows,
                isLoading: mentionLoading,
                isReady: !mentionLoading,
                status: mentionLoading ? 'loading' : 'ready',
            }
        }
        return { data: [], isLoading: false, isReady: true, status: 'ready' }
    },
}))

// `useMutation` wraps a generator into mutateAsync. The real version
// awaits each yielded Transaction's `isPersisted.promise`; we mirror
// that here in-process so the addReply call resolves once every
// insert has been called.
vi.mock('@tinycld/core/lib/mutations', () => ({
    useMutation: (opts: {
        mutationFn: (
            vars: unknown
        ) => Generator<
            | { isPersisted: { promise: Promise<unknown> } }
            | Array<{ isPersisted: { promise: Promise<unknown> } }>,
            unknown,
            void
        >
    }) => ({
        mutateAsync: async (vars: unknown) => {
            const gen = opts.mutationFn(vars)
            let next = gen.next()
            while (!next.done) {
                const value = next.value
                if (Array.isArray(value)) {
                    await Promise.all(value.map(tx => tx.isPersisted.promise))
                } else {
                    await value.isPersisted.promise
                }
                next = gen.next()
            }
            return next.value
        },
        isPending: false,
        isError: false,
    }),
}))

// `pbtsdb/core` exports `newRecordId()`; we stub it to a counter so
// inserts are deterministic per test.
let recordIdCounter = 0
vi.mock('pbtsdb/core', () => ({
    newRecordId: () => `rec_${++recordIdCounter}`,
}))

import { useSuggestionDiscussion } from '~/tinycld/text/lib/suggestions/discussions'

const DRIVE_ITEM = 'di_doc_1'
const ME = 'uo_me'

beforeEach(() => {
    commentRows = []
    mentionRows = []
    commentLoading = false
    mentionLoading = false
    recordIdCounter = 0
    textCommentsInsert.mockClear()
    commentMentionsInsert.mockClear()
})

afterEach(() => {
    vi.clearAllMocks()
})

describe('useSuggestionDiscussion', () => {
    it('returns empty replies + no-op addReply when suggestionId is null', async () => {
        commentRows = [
            {
                id: 'c1',
                suggestion_id: 's1',
                author: 'uo_alice',
                body: 'irrelevant',
                created: '2026-05-29T00:00:00Z',
            },
        ]
        const { result } = renderHook(() => useSuggestionDiscussion(null, DRIVE_ITEM, ME))

        expect(result.current.replies).toEqual([])
        expect(result.current.isLoading).toBe(false)

        await act(async () => {
            await result.current.addReply('hello', ['uo_bob'])
        })
        // No insert was attempted for null suggestion.
        expect(textCommentsInsert).not.toHaveBeenCalled()
        expect(commentMentionsInsert).not.toHaveBeenCalled()
    })

    it('returns replies with mentions parsed from the body tokens', () => {
        commentRows = [
            {
                id: 'c_later',
                suggestion_id: 's1',
                author: 'uo_alice',
                body: 'hey [[@uo_carol]] and [[@uo_dave]] take a look',
                created: '2026-05-29T00:00:02Z',
            },
            {
                id: 'c_earlier',
                suggestion_id: 's1',
                author: 'uo_bob',
                body: 'first',
                created: '2026-05-29T00:00:01Z',
            },
        ]
        // We intentionally do NOT seed mentionRows: the hook no
        // longer subscribes to comment_mentions on the client
        // (that collection's listRule is null and would 403). The
        // mention list per reply is extracted from the body's
        // [[@userOrgId]] tokens.
        const { result } = renderHook(() => useSuggestionDiscussion('s1', DRIVE_ITEM, ME))

        expect(result.current.replies).toHaveLength(2)
        const [a, b] = result.current.replies
        expect(a.id).toBe('c_later')
        expect(a.authorId).toBe('uo_alice')
        expect(a.body).toBe('hey [[@uo_carol]] and [[@uo_dave]] take a look')
        expect(a.suggestionId).toBe('s1')
        expect(a.mentions).toEqual(['uo_carol', 'uo_dave'])
        expect(typeof a.createdAt).toBe('number')
        expect(b.id).toBe('c_earlier')
        expect(b.mentions).toEqual([])
    })

    it('addReply writes a text_comments row with suggestion_id set + comment_id synthesized', async () => {
        const { result } = renderHook(() => useSuggestionDiscussion('s1', DRIVE_ITEM, ME))

        await act(async () => {
            await result.current.addReply('looks good', [])
        })

        expect(textCommentsInsert).toHaveBeenCalledTimes(1)
        const row = textCommentsInsert.mock.calls[0][0] as Record<string, unknown>
        expect(row).toMatchObject({
            suggestion_id: 's1',
            drive_item: DRIVE_ITEM,
            author: ME,
            body: 'looks good',
            quoted_text: '',
            parent_comment: '',
            resolved_at: '',
            // No displayName passed in this case → fallback to
            // 'Anonymous' (mirrors core/lib/comments/mutations.ts).
            author_name: 'Anonymous',
        })
        // comment_id is a synthesized id, not blank — required field
        // on the PB collection that has no semantic meaning for a
        // suggestion reply, but must be non-empty.
        expect(typeof row.comment_id).toBe('string')
        expect((row.comment_id as string).length).toBeGreaterThan(0)
        // No mentions on this reply, so no comment_mentions inserts.
        expect(commentMentionsInsert).not.toHaveBeenCalled()
    })

    it('addReply snapshots the caller-supplied displayName into author_name', async () => {
        const { result } = renderHook(() =>
            useSuggestionDiscussion('s1', DRIVE_ITEM, ME, 'Alice Owner')
        )

        await act(async () => {
            await result.current.addReply('looks good', [])
        })

        const row = textCommentsInsert.mock.calls[0][0] as Record<string, unknown>
        // The display name flows through unchanged so the comment-row
        // surface attribution survives the user's user_org being
        // deleted later (mirrors the regular comment-mutation path).
        expect(row.author_name).toBe('Alice Owner')
    })

    it('addReply writes one comment_mentions row per mentioned user (deduped, self-mention skipped)', async () => {
        const { result } = renderHook(() => useSuggestionDiscussion('s1', DRIVE_ITEM, ME))

        await act(async () => {
            // Includes a duplicate (uo_bob twice) and a self-mention
            // (ME), both of which should be filtered out by the
            // mention writer — mirrors the comment-composer behaviour.
            await result.current.addReply('cc @bob @carol', ['uo_bob', 'uo_carol', 'uo_bob', ME])
        })

        expect(textCommentsInsert).toHaveBeenCalledTimes(1)
        const commentRow = textCommentsInsert.mock.calls[0][0] as { id: string }
        expect(commentMentionsInsert).toHaveBeenCalledTimes(2)
        const mentionRowsWritten = commentMentionsInsert.mock.calls.map(
            c => c[0] as Record<string, unknown>
        )
        expect(mentionRowsWritten.map(r => r.mentioned_user_org).sort()).toEqual([
            'uo_bob',
            'uo_carol',
        ])
        // Every mention row points back at the freshly-inserted
        // comment record and carries the right collection name for
        // the notify hook's allowlist.
        for (const m of mentionRowsWritten) {
            expect(m.comment_record).toBe(commentRow.id)
            expect(m.comment_collection).toBe('text_comments')
            expect(m.drive_item).toBe(DRIVE_ITEM)
        }
    })

    it('archived_at rows are filtered out of the result', () => {
        commentRows = [
            {
                id: 'c_live',
                suggestion_id: 's1',
                author: 'uo_alice',
                body: 'still here',
                created: '2026-05-29T00:00:01Z',
            },
            {
                id: 'c_dead',
                suggestion_id: 's1',
                author: 'uo_alice',
                body: 'archived',
                created: '2026-05-29T00:00:02Z',
                archived_at: '2026-05-29T01:00:00Z',
            },
        ]
        const { result } = renderHook(() => useSuggestionDiscussion('s1', DRIVE_ITEM, ME))
        expect(result.current.replies).toHaveLength(1)
        expect(result.current.replies[0].id).toBe('c_live')
    })
})
