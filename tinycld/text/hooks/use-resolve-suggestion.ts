import { captureException } from '@tinycld/core/lib/errors'
import { useMutation } from '@tinycld/core/lib/mutations'
import { useCurrentRole } from '@tinycld/core/lib/use-current-role'
import type { Editor } from '@tiptap/core'
import { useCallback } from 'react'
import type * as Y from 'yjs'
import { acceptSuggestion, rejectSuggestion } from '../lib/suggestions/resolve'

export interface UseResolveSuggestion {
    accept: () => Promise<void>
    reject: () => Promise<void>
    isPending: boolean
    error: Error | null
}

interface ResolveVariables {
    kind: 'accept' | 'reject'
}

// useResolveSuggestion — wraps acceptSuggestion / rejectSuggestion in a
// TanStack mutation so the SuggestionPopover can drive an isPending +
// error state. The underlying resolve functions execute synchronously
// (apply a ProseMirror transaction inline and write to the suggestions
// Y.Map), so the mutation wrapper isn't strictly necessary today — but
// it gives us a stable place to add server-side coordination later
// (e.g. a broker round-trip for confirmation) without changing
// callers, and the isPending flag lets the popover disable both
// buttons while the apply is in flight.
//
// The hook is keyed by suggestionId so a stale mutation triggered from
// an older popover invocation can't apply to the wrong suggestion.
// We read the resolver's userOrgId from useCurrentRole (the same hook
// the screen uses for identity wiring); both acceptSuggestion and
// rejectSuggestion stamp the resolution event with this id so audit
// history can attribute the resolution to a specific member.
//
// Null guards: if the editor isn't mounted (the native variant where
// the WebView owns the editor and tiptapEditor is null) or the yDoc
// is missing, both callbacks no-op rather than throwing. Native
// callers won't reach this code path in Phase 2a because the WebView
// owns the editor; the guard is for defensive consistency with the
// rest of the package.
export function useResolveSuggestion(
    suggestionId: string,
    options: { editor: Editor | null; yDoc: Y.Doc | null }
): UseResolveSuggestion {
    const { userOrgId } = useCurrentRole()
    const { editor, yDoc } = options

    const mutation = useMutation<void, Error, ResolveVariables>({
        mutationFn: async ({ kind }) => {
            if (!editor || !yDoc) return
            if (!userOrgId) throw new Error('useResolveSuggestion: missing userOrgId')
            if (kind === 'accept') {
                acceptSuggestion(editor, suggestionId, {
                    resolverUserOrgId: userOrgId,
                    yDoc,
                })
            } else {
                rejectSuggestion(editor, suggestionId, {
                    resolverUserOrgId: userOrgId,
                    yDoc,
                })
            }
        },
        onError: error => {
            captureException('text.resolveSuggestion', error, { suggestionId })
        },
    })

    const accept = useCallback(() => mutation.mutateAsync({ kind: 'accept' }), [mutation])
    const reject = useCallback(() => mutation.mutateAsync({ kind: 'reject' }), [mutation])

    return {
        accept,
        reject,
        isPending: mutation.isPending,
        error: mutation.error,
    }
}
