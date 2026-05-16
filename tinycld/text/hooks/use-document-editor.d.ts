import type { EditorResult } from '@tinycld/core/lib/editor/types'
import type { Editor as TiptapEditor } from '@tiptap/react'
import type { Awareness } from 'y-protocols/awareness'
import type * as Y from 'yjs'
import type { FindReplaceEditor } from '../lib/find-replace-plugin'

export interface UseDocumentEditorOptions {
    yDoc: Y.Doc
    awareness: Awareness
    user?: { id?: string; name: string; color: string }
    editable?: boolean
    placeholder?: string
    // Forwarded to the native variant which uses it to open the in-
    // WebView realtime connection. Web variant ignores.
    driveItemId?: string
    // Invoked by the slash menu's "Image" entry. The host owns the
    // file/URL picker + drive upload pipeline and routes the resulting
    // src back through `commands.insertImage`. Web-only; native
    // ignores.
    onRequestInsertImage?: () => void
}

// Host-side surface for the comment system. The web variant binds
// this to the in-page Tiptap editor (direct command + event API).
// The native variant returns null in v1 — wiring the WebView's
// message-bus comment channel into a host bridge is deferred until
// text on native moves past the placeholder. Consumers must tolerate
// null (e.g. by not mounting comment UI when this is null).
export interface DocumentCommentBridge {
    // Apply the comment mark. When `range` is provided the selection is
    // restored to it before the mark is set — required when the call
    // site is a button/modal that has moved focus off the editor,
    // collapsing ProseMirror's selection. Without `range`, falls back
    // to whatever selection the editor currently holds.
    addComment: (commentId: string, range?: { from: number; to: number }) => void
    removeComment: (commentId: string) => void
    // Scroll the marked range into view and select it. No-op when the
    // mark isn't present in the doc (e.g. the anchor is orphaned).
    // Returns true on a successful jump so the caller can fall back to
    // a drawer-only focus when this returns false.
    focusComment: (commentId: string) => boolean
    getSelection: () => { from: number; to: number } | null
    onTap: (handler: (commentId: string) => void) => () => void
    onRemoved: (handler: (commentIds: string[]) => void) => () => void
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
    commentBridge: DocumentCommentBridge | null
}

export function useDocumentEditor(options: UseDocumentEditorOptions): DocumentEditorResult
