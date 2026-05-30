import { Extension } from '@tiptap/core'
import type * as Y from 'yjs'
import { createAuthorshipDecorationPlugin } from './authorship-decoration-plugin'

// Options exposed as factory callbacks instead of plain values so the
// host hook (use-document-editor.web) can swap the underlying enabled
// flag / yDoc / clientAuthors snapshot without forcing TipTap to
// reconfigure (which would tear down the editor and reset the Y.Doc
// binding). Refs in the hook stay current across renders while the
// extension's identity remains stable.
export interface AuthorshipExtensionOptions {
    getEnabled: () => boolean
    getYDoc: () => Y.Doc | null
    getClientAuthors: () => Map<number, string>
}

export const AuthorshipExtension = Extension.create<AuthorshipExtensionOptions>({
    name: 'tinycldAuthorship',
    addOptions() {
        return {
            getEnabled: () => false,
            getYDoc: () => null,
            getClientAuthors: () => new Map(),
        }
    },
    addProseMirrorPlugins() {
        return [
            createAuthorshipDecorationPlugin({
                getEnabled: this.options.getEnabled,
                getYDoc: this.options.getYDoc,
                getClientAuthors: this.options.getClientAuthors,
            }),
        ]
    },
})
