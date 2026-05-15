import type { EditorResult } from '@tinycld/core/lib/editor/types'
import type { Awareness } from 'y-protocols/awareness'
import type * as Y from 'yjs'

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

export function useDocumentEditor(options: UseDocumentEditorOptions): EditorResult
