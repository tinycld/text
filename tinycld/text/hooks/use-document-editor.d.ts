import type { EditorResult } from '@tinycld/core/lib/editor/types'
import type { Editor as TiptapEditor } from '@tiptap/react'
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

// The web variant exposes the raw Tiptap editor so callers can attach
// their own transaction listeners (WordCountBadge) without rendering
// the whole toolbar each keystroke. It also exposes findReplaceEditor
// (the state+dispatch shim driven by the Cmd+F bar). Both are null on
// native, where the WebView owns the canonical editor and the host
// shell has no ProseMirror dispatch handle.
export interface DocumentEditorResult extends EditorResult {
    tiptapEditor: TiptapEditor | null
    findReplaceEditor: FindReplaceEditor | null
}

export function useDocumentEditor(options: UseDocumentEditorOptions): DocumentEditorResult
