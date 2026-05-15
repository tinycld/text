import type { Awareness } from 'y-protocols/awareness'
import type * as Y from 'yjs'
import type { EditorResult } from '@tinycld/core/lib/editor/types'

export interface UseDocumentEditorOptions {
    yDoc: Y.Doc
    awareness: Awareness
    user?: { name: string; color: string }
    editable?: boolean
    placeholder?: string
}

export function useDocumentEditor(options: UseDocumentEditorOptions): EditorResult
