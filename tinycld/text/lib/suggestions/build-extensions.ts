import {
    SuggestedBlockChange,
    SuggestedDelete,
    SuggestedInsert,
} from '../../webview-editor/source/suggestions'

// buildSuggestionEditorExtensions returns the TipTap extensions that
// implement the change-tracking schema. Both editor mounts (the inline
// web mount in hooks/use-document-editor.web.tsx and the WebView mount
// in webview-editor/source/Editor.tsx) MUST include these so the
// schema is identical across platforms — without this parity, edits
// authored on one platform silently drop schema-unknown content when
// rendered on the other.
//
// Phase 2a starts by registering just the bare schema extensions; a
// later task in this phase extends this function to accept options
// (modeStore, yDoc) that configure a command layer.
export function buildSuggestionEditorExtensions() {
    return [SuggestedInsert, SuggestedDelete, SuggestedBlockChange]
}
