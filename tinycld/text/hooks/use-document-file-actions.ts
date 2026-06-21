import { useEditorMount } from '@tinycld/core/lib/editor/editor-mount'
import { useOrgHref } from '@tinycld/core/lib/org-routes'
import {
    type DriveItemFileActions,
    useDriveItemFileActions,
} from '@tinycld/drive/hooks/use-drive-item-file-actions'
import { router } from 'expo-router'
import { useCallback } from 'react'

export type DocumentFileActions = DriveItemFileActions

// Thin wrapper over drive's shared file-actions hook with text's
// post-trash redirect target.
export function useDocumentFileActions(documentId: string): DocumentFileActions {
    const { capabilities } = useEditorMount()
    const orgHref = useOrgHref()
    const onTrashed = useCallback(() => {
        router.replace(orgHref('text'))
    }, [orgHref])
    const actions = useDriveItemFileActions({
        itemId: documentId,
        onTrashed,
        roomKind: 'text-doc',
    })
    // Guests (no org membership) can't rename/trash/copy/open-in-drive.
    // Return inert handlers so any still-mounted control is a no-op.
    if (!capabilities.canUseFileActions) {
        return {
            rename: () => {},
            makeCopy: () => {},
            exportAsTemplate: () => {},
            moveToTrash: () => {},
            openDriveDetails: () => {},
        }
    }
    return actions
}
