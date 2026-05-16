import type { EditorResult } from '@tinycld/core/lib/editor/types'
import type { Awareness } from 'y-protocols/awareness'
import type * as Y from 'yjs'
import type { FindReplaceEditor } from '../lib/find-replace-plugin'

export interface UseDocumentEditorOptions {
    yDoc: Y.Doc
    awareness: Awareness
    user?: { name: string; color: string }
    editable?: boolean
    placeholder?: string
    // Forwarded to the native variant which uses it to open the in-
    // WebView realtime connection. Web variant ignores.
    driveItemId?: string
}

// findReplaceEditor is web-only — on native the WebView owns the
// canonical editor and the host shell has no ProseMirror state to
// expose. The native variant returns null so screen code can branch
// on `editorResult.findReplaceEditor != null` without a platform
// check.
export interface ExtendedEditorResult extends EditorResult {
    findReplaceEditor: FindReplaceEditor | null
}

export function useDocumentEditor(options: UseDocumentEditorOptions): ExtendedEditorResult
