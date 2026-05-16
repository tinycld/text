import { createContext, useContext } from 'react'
import type { FindReplaceEditor } from './find-replace-plugin'

// Context that publishes the underlying ProseMirror editor (or a
// thin shim implementing the same dispatch + state surface) so the
// FindReplaceBar can drive the find/replace plugin without importing
// the editor hook directly. The provider is mounted by screens/[id].tsx
// around the document tree; the consumer is FindReplaceBar +
// useFindReplaceShortcuts.
//
// `null` means "no editor mounted" (web variant before tiptap inits,
// or the native variant where the WebView owns the editor and the
// host shell has no ProseMirror dispatch handle). The bar should
// treat that the same as "editor not ready" and disable its action
// buttons.
export const FindReplaceEditorContext = createContext<FindReplaceEditor | null>(null)

export function useFindReplaceEditor(): FindReplaceEditor | null {
    return useContext(FindReplaceEditorContext)
}
