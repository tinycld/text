import { eq } from '@tanstack/db'
import { useStore } from '@tinycld/core/lib/pocketbase'
import { useOrgLiveQuery } from '@tinycld/core/lib/use-org-live-query'

// useAuthorName resolves the display name for a users id. Reads the
// user record directly so we render the human-readable name, falling
// back to the email if name is unset.
// Returns null while the query is loading or when the id doesn't
// resolve (anonymous / orphan id), letting callers degrade
// gracefully — Activity rows render "Someone made N edits", blame
// rows render "Anonymous", drawer rows render the raw id.
//
// Originally inlined in ActivityTab.tsx (Phase 3b Task 12); extracted
// here in Phase 3c so AuthorshipPopover, AuthorshipTab, SuggestionRow
// can reuse the exact same lookup without duplicating the join + the
// null-handling.
//
// The hook accepts a nullable authorId so callers can pass
// `AuthorshipRun.authorId` (which is `string | null`) directly without
// branching. A null id short-circuits to null without subscribing.
//
// One TanStack DB subscription per call site is the cost — typical
// activity / contributor feeds have <100 rows and most reuse the same
// handful of authorIds, so TanStack DB's caching makes this cheap in
// practice.
export function useAuthorName(authorId: string | null): string | null {
    const [usersCollection] = useStore('users')
    const { data: rows } = useOrgLiveQuery(
        query =>
            query
                .from({ u: usersCollection })
                .where(({ u }) => eq(u.id, authorId ?? ''))
                .select(({ u }) => ({ name: u.name, email: u.email })),
        [authorId]
    )
    if (authorId === null) return null
    const row = rows?.[0] as { name: string | null; email: string | null } | undefined
    if (!row) return null
    return row.name || row.email || null
}
