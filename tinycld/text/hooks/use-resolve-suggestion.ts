import { useAuth } from '@tinycld/core/lib/auth'
import { captureException } from '@tinycld/core/lib/errors'
import type { Editor } from '@tiptap/core'
import { useCallback, useState } from 'react'
import type * as Y from 'yjs'
import { acceptSuggestion, rejectSuggestion } from '../lib/suggestions/resolve'

export interface UseResolveSuggestionService {
    accept: (suggestionId: string) => Promise<void>
    reject: (suggestionId: string) => Promise<void>
    isPending: boolean
}

// useResolveSuggestionService produces accept/reject mutations that
// operate on any suggestionId — useful when the caller (the popover
// for layered marks, the review drawer for any open suggestion) needs
// to dispatch to different ids over the lifetime of one mount.
//
// Phase 2a's per-id useResolveSuggestion(id, options) was sufficient
// when the popover only handled one suggestion; with layered-marks
// support, the popover now renders N rows and needs to call accept(id)
// per click. The drawer (Task 9) will also use the service shape so
// one mounted hook can dispatch to whichever row the viewer clicks.
//
// Synchronous in effect — acceptSuggestion/rejectSuggestion apply a
// ProseMirror transaction inline and write to the suggestions Y.Map —
// but exposes isPending for the brief window during async caller-side
// teardown (the popover's dismiss handler is async). Both callbacks
// no-op when editor or yDoc is null (the native variant where the
// WebView owns the editor), matching Phase 2a's defensive guard.
//
// The resolver's user id comes from useAuth (the same identity the
// screen uses for identity wiring); both acceptSuggestion and
// rejectSuggestion stamp the resolution event with this id so audit
// history can attribute the resolution to a specific member.
export function useResolveSuggestionService(options: {
    editor: Editor | null
    yDoc: Y.Doc | null
    // When true, accept/reject collapse to no-ops without running the
    // resolver. Used by read-only viewer mounts where the resolve
    // affordances are never reachable — the live-query in
    // useCurrentRole still runs (the screen calls it elsewhere too)
    // but the callbacks themselves don't carry the resolver closures.
    // See screens/[id].tsx for the read-only design decision.
    disabled?: boolean
}): UseResolveSuggestionService {
    const { user } = useAuth()
    const userId = user.id
    const { editor, yDoc, disabled } = options
    const [isPending, setIsPending] = useState(false)

    const accept = useCallback(
        async (suggestionId: string) => {
            if (disabled) return
            if (!editor || !yDoc || !userId) return
            setIsPending(true)
            try {
                acceptSuggestion(editor, suggestionId, {
                    resolverUserOrgId: userId,
                    yDoc,
                })
            } catch (error) {
                captureException('text.resolveSuggestion', error as Error, {
                    suggestionId,
                    kind: 'accept',
                })
            } finally {
                setIsPending(false)
            }
        },
        [editor, yDoc, userId, disabled]
    )

    const reject = useCallback(
        async (suggestionId: string) => {
            if (disabled) return
            if (!editor || !yDoc || !userId) return
            setIsPending(true)
            try {
                rejectSuggestion(editor, suggestionId, {
                    resolverUserOrgId: userId,
                    yDoc,
                })
            } catch (error) {
                captureException('text.resolveSuggestion', error as Error, {
                    suggestionId,
                    kind: 'reject',
                })
            } finally {
                setIsPending(false)
            }
        },
        [editor, yDoc, userId, disabled]
    )

    return { accept, reject, isPending }
}
