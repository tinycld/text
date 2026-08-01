import { and, eq } from '@tanstack/db'
import { useStore } from '@tinycld/core/lib/pocketbase'
import { useOrgLiveQuery } from '@tinycld/core/lib/use-org-live-query'

export interface SuggestionPermissions {
    canEdit: boolean
    canSuggest: boolean
    canResolve: boolean
}

// useSuggestionPermissions returns the three permission flags for the
// current user's drive_shares role on the given drive_item:
//
//   - canEdit:    can apply normal (non-suggestion) edits
//   - canSuggest: can switch to Suggesting mode and propose changes
//   - canResolve: can accept/reject existing suggestions
//
// Source of truth: the drive_shares row that connects the current
// user's user to this drive_item. The text server's
// `resolveShareRole` (text/server/authorize.go) does the same lookup
// to compute `hello.readOnly`, and gates writes server-side based on
// the same predicate. We mirror that role check in the UI so the mode
// menu only offers Editing / Suggesting to users who could actually
// write — but the server, not this hook, is the final authority. Any
// write attempt from a stale or spoofed UI is rejected by the realtime
// connection's read-only flag.
//
// Phase 2a: all three flags share the same condition — owner or
// editor. A future phase may introduce a reviewer-only role that can
// suggest but not directly edit; the hook's three-flag shape makes
// that split a one-line change here.
//
// Until the drive_shares row resolves (initial render, cross-org
// stale shares, missing share altogether), the hook returns all false
// — a defensive default that hides Suggesting / Accept / Reject
// affordances while the role is loading or unknown. Viewer and
// commentor users land on the same all-false result, matching the
// server's read-only gate.
export function useSuggestionPermissions(driveItemId: string): SuggestionPermissions {
    const [sharesCollection] = useStore('drive_shares')

    const { data: shareRows } = useOrgLiveQuery(
        (query, { userId }) =>
            query
                .from({ s: sharesCollection })
                .where(({ s }) => and(eq(s.item, driveItemId), eq(s.user, userId))),
        [driveItemId]
    )

    // driveshare.ResolveRole on the server picks the highest-priority role
    // when multiple share rows match (owner > editor > viewer); we
    // need the same behavior here so an editor row added on top of an
    // older viewer row doesn't lock the user out.
    const role = highestRole(shareRows)
    const canEditOrSuggest = role === 'owner' || role === 'editor'

    return {
        canEdit: canEditOrSuggest,
        canSuggest: canEditOrSuggest,
        canResolve: canEditOrSuggest,
    }
}

const ROLE_PRIORITY: Record<string, number> = {
    owner: 3,
    editor: 2,
    commentor: 1.5,
    viewer: 1,
}

function highestRole(rows: { role: string }[] | undefined): string | null {
    if (!rows || rows.length === 0) return null
    let best: string | null = null
    let bestPriority = 0
    for (const row of rows) {
        const priority = ROLE_PRIORITY[row.role] ?? 0
        if (priority > bestPriority) {
            best = row.role
            bestPriority = priority
        }
    }
    return best
}
