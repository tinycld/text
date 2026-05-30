import { Plugin, PluginKey } from '@tiptap/pm/state'
import { DecorationSet } from '@tiptap/pm/view'
import type * as Y from 'yjs'

// Plugin key exported so a future enhancement (or a debug surface) can
// pluck the decoration set out of the editor state without having to
// re-create the plugin instance.
export const authorshipDecorationPluginKey = new PluginKey('tinycldAuthorshipDecoration')

export interface AuthorshipPluginOptions {
    getEnabled: () => boolean
    getYDoc: () => Y.Doc | null
    getClientAuthors: () => Map<number, string>
}

// v1: the plugin scaffolding (state init, apply on transaction,
// decorations prop) is in place but the decoration set stays empty
// unconditionally. Per-character coloring lands as a follow-up; the
// proper implementation requires reaching into y-prosemirror's
// PM-pos ↔ Y.XmlText mapping which isn't worth the complexity for an
// opt-in visualization. The Authorship popover (Task 8) covers the
// high-value blame use case in the meantime.
//
// `_opts` is intentionally retained on the signature so wiring callers
// (the TipTap extension in Task 6) can pass through the
// enabled/yDoc/clientAuthors callbacks without a follow-up signature
// change when the real implementation lands.
export function createAuthorshipDecorationPlugin(_opts: AuthorshipPluginOptions): Plugin {
    return new Plugin({
        key: authorshipDecorationPluginKey,
        state: {
            init: () => DecorationSet.empty,
            // The plugin still observes transactions so a future
            // enhancement can fill in buildDecorations without
            // re-wiring the editor. The current stub keeps the
            // decoration set empty regardless of the options.
            apply: (_tr, old) => old,
        },
        props: {
            decorations(state) {
                return this.getState(state)
            },
        },
    })
}
