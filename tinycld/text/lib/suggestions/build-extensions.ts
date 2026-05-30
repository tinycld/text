import type { AnyExtension } from '@tiptap/core'
import type * as Y from 'yjs'
import type { EditorModeStore } from '../../stores/editor-mode-store'
import {
    SuggestedBlockChange,
    SuggestedDelete,
    SuggestedFormatChange,
    SuggestedInsert,
} from '../../webview-editor/source/suggestions'
import { SuggestionClickToFocus } from './click-to-focus'
import { SuggestionCommandLayer } from './command-layer'
import { SuggestionDecorations } from './decorations'

export interface SuggestionEditorExtensionOptions {
    modeStore?: EditorModeStore
    yDoc?: Y.Doc
    // When true, the editor mount is a read-only viewer surface and
    // suggestion-related UI (decoration rendering, click-to-focus
    // handler, command layer) is omitted. The SCHEMA marks
    // (SuggestedInsert/Delete/FormatChange/BlockChange) still ship so
    // y-prosemirror can decode existing marks without throwing — only
    // the visible affordances are gated. See screens/[id].tsx for the
    // read-only design decision.
    readOnly?: boolean
}

// buildSuggestionEditorExtensions returns the TipTap extensions that
// implement the change-tracking schema. Both editor mounts (the inline
// web mount in hooks/use-document-editor.web.tsx and the WebView mount
// in webview-editor/source/Editor.tsx) MUST include these so the
// schema is identical across platforms. Without this parity, edits
// authored on one platform silently drop schema-unknown content when
// rendered on the other — there's no error, just silent data loss.
//
// When called with { modeStore, yDoc }, the command layer is configured
// to intercept user transactions in suggesting mode. When called
// without options (schema-only contexts like tests + type checks),
// the command layer is included but inert — its plugin returns an
// empty plugin list because it can't operate without the store and
// document.
export function buildSuggestionEditorExtensions(
    options: SuggestionEditorExtensionOptions = {}
): AnyExtension[] {
    // Schema marks ship to every mount so y-prosemirror's mark-set
    // matches the on-disk doc on parse — without these, an existing
    // Yjs run carrying `suggestedDelete--<hash>` would be dropped on
    // load even on a read-only viewer.
    const baseExtensions: AnyExtension[] = [
        SuggestedInsert,
        SuggestedDelete,
        SuggestedBlockChange,
        SuggestedFormatChange,
    ]
    if (options.readOnly) {
        // Viewer mount: omit the decoration / click / command-layer
        // plugins. The schema marks above keep the Yjs parse safe.
        return baseExtensions
    }
    baseExtensions.push(SuggestionDecorations, SuggestionClickToFocus)
    if (options.modeStore && options.yDoc) {
        baseExtensions.push(
            SuggestionCommandLayer.configure({
                modeStore: options.modeStore,
                yDoc: options.yDoc,
            })
        )
    } else {
        baseExtensions.push(SuggestionCommandLayer)
    }
    return baseExtensions
}
