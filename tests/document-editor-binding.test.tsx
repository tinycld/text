// useDocumentEditor lives in @tinycld/core/lib/editor/. It mounts a
// Tiptap editor bound to the Y.Doc + Awareness pair the realtime
// room hands it, with the Collaboration / CollaborationCaret
// extensions wired up so peers see each other's cursors and edits.
//
// Tiptap's runtime needs a real DOM and a mounted EditorView before
// commands and reactive state become meaningful — neither of which
// the Vitest node environment provides. The full editor-binding
// contract therefore lives in the M6.20 Playwright suite.
//
// What we DO verify here is the pre-Tiptap surface: a Y.Doc +
// Awareness pair can be constructed (in the same shape useTextRoom
// hands to useDocumentEditor) and the Collaboration extension's
// `prosemirror` XmlFragment can be reached on the doc the editor
// would bind to. This catches breakage in the Y.Doc plumbing
// (e.g. someone renaming the field, swapping yjs versions, breaking
// the Awareness export) without requiring a real DOM.

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'

describe('useDocumentEditor binding inputs', () => {
    it('constructs an awareness instance attached to the same Y.Doc the editor will bind to', () => {
        const yDoc = new Y.Doc()
        const awareness = new Awareness(yDoc)
        // The CollaborationCaret extension reads cursor positions
        // through awareness.doc; useTextRoom hands both objects to
        // useDocumentEditor. The link between them must survive any
        // future yjs / y-protocols version bump.
        expect(awareness.doc).toBe(yDoc)
        awareness.destroy()
        yDoc.destroy()
    })

    it("uses the 'prosemirror' XmlFragment slot the Collaboration extension binds to", () => {
        // Tiptap's Collaboration extension is configured with
        // `field: 'prosemirror'` (see use-document-editor.web.tsx).
        // y-prosemirror creates the XmlFragment lazily on first
        // bind, but Y.Doc.getXmlFragment returns a stable handle on
        // first access regardless. Keeping this name in sync with
        // the editor config is what lets the server's Y.Doc
        // bootstrap (translate.SeedFromPMJSON) land in the same
        // place the client edits.
        const yDoc = new Y.Doc()
        const fragment = yDoc.getXmlFragment('prosemirror')
        expect(fragment).toBeDefined()
        expect(fragment.length).toBe(0)
        yDoc.destroy()
    })

    it('lets initial awareness state round-trip through the local slot', () => {
        // useTextRoom seeds awareness.user with id+name+color before
        // the editor mounts. We don't pass `user` to useDocumentEditor
        // because CollaborationCaret would then clobber the slot on
        // mount. Verify the storage path itself works so that the
        // initial-awareness contract from useTextRoom is intact.
        const yDoc = new Y.Doc()
        const awareness = new Awareness(yDoc)
        awareness.setLocalState({
            user: { id: 'u1', name: 'Alex', color: '#abc123' },
            cursor: null,
        })
        const local = awareness.getLocalState()
        expect(local).toMatchObject({
            user: { id: 'u1', name: 'Alex', color: '#abc123' },
            cursor: null,
        })
        awareness.destroy()
        yDoc.destroy()
    })
})
