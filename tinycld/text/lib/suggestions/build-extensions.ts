import type { AnyExtension } from '@tiptap/core'
import type * as Y from 'yjs'
import type { EditorModeStore } from '../../stores/editor-mode-store'
import {
    SuggestedBlockChange,
    SuggestedDelete,
    SuggestedInsert,
} from '../../webview-editor/source/suggestions'
import { SuggestionCommandLayer } from './command-layer'
import { SuggestionDecorations } from './decorations'
import { SuggestionPopover } from './popover'

export interface SuggestionEditorExtensionOptions {
    modeStore?: EditorModeStore
    yDoc?: Y.Doc
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
    const baseExtensions: AnyExtension[] = [
        SuggestedInsert,
        SuggestedDelete,
        SuggestedBlockChange,
        SuggestionDecorations,
        SuggestionPopover,
    ]
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
