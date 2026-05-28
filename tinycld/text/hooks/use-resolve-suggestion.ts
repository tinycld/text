import { captureException } from '@tinycld/core/lib/errors'
import { useCurrentRole } from '@tinycld/core/lib/use-current-role'
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
// The resolver's userOrgId comes from useCurrentRole (the same hook
// the screen uses for identity wiring); both acceptSuggestion and
// rejectSuggestion stamp the resolution event with this id so audit
// history can attribute the resolution to a specific member.
export function useResolveSuggestionService(options: {
    editor: Editor | null
    yDoc: Y.Doc | null
}): UseResolveSuggestionService {
    const { userOrgId } = useCurrentRole()
    const { editor, yDoc } = options
    const [isPending, setIsPending] = useState(false)

    const accept = useCallback(
        async (suggestionId: string) => {
            if (!editor || !yDoc || !userOrgId) return
            setIsPending(true)
            try {
                acceptSuggestion(editor, suggestionId, {
                    resolverUserOrgId: userOrgId,
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
        [editor, yDoc, userOrgId]
    )

    const reject = useCallback(
        async (suggestionId: string) => {
            if (!editor || !yDoc || !userOrgId) return
            setIsPending(true)
            try {
                rejectSuggestion(editor, suggestionId, {
                    resolverUserOrgId: userOrgId,
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
        [editor, yDoc, userOrgId]
    )

    return { accept, reject, isPending }
}
