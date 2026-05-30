import { and, eq } from '@tanstack/db'
import { useStore } from '@tinycld/core/lib/pocketbase'
import { useOrgLiveQuery } from '@tinycld/core/lib/use-org-live-query'

// useAuthorName resolves the display name for a user_org id. Two-table
// join (user_org → users) so we render the human-readable name from
// the user record, falling back to the email if name is unset.
// Returns null while the query is loading or when the id doesn't
// resolve (anonymous / orphan / cross-org id), letting callers degrade
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
    const [userOrgCollection, usersCollection] = useStore('user_org', 'users')
    const { data: rows } = useOrgLiveQuery(
        (query, { orgId }) =>
            query
                .from({ uo: userOrgCollection })
                .join({ u: usersCollection }, ({ uo, u }) => eq(uo.user, u.id))
                .where(({ uo }) => and(eq(uo.id, authorId ?? ''), eq(uo.org, orgId)))
                .select(({ u }) => ({ name: u.name, email: u.email })),
        [authorId]
    )
    if (authorId === null) return null
    const row = rows?.[0] as { name: string | null; email: string | null } | undefined
    if (!row) return null
    return row.name || row.email || null
}
