// Unit tests for deriveImageSelection — the helper Editor.tsx uses to
// pull image-selection metadata off the active editor selection and
// emit it on the ui.selection-changed channel. The native bottom
// sheet hangs off the result, so getting the wire shape right is
// load-bearing.
//
// We sidestep needing a full ProseMirror editor by constructing real
// Selection objects (NodeSelection, TextSelection) over a tiny
// document. NodeSelection is exposed from @tiptap/pm/state — the
// same import the production code uses. View is always passed as
// null here (the production path passes editor.view); the helper's
// DOM block is gated on view !== null, so null exercises the
// "natural dimensions unknown" path the bottom sheet uses to dim
// its Size buttons before the image loads.

import { Node, Schema } from '@tiptap/pm/model'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { describe, expect, it } from 'vitest'
import {
    deriveImageSelection,
    type EditorWithState,
} from '../tinycld/text/webview-editor/source/editor-state'

// Mini-schema shaped like the editor's: a paragraph containing inline
// text + an inline image with the same attrs WrappedImage carries
// (src, alt, wrap, width, height). The image must be inline so it can
// hold a NodeSelection inside a paragraph.
const schema = new Schema({
    nodes: {
        doc: { content: 'block+' },
        paragraph: {
            content: 'inline*',
            group: 'block',
            toDOM: () => ['p', 0],
        },
        text: { group: 'inline' },
        image: {
            inline: true,
            group: 'inline',
            atom: true,
            attrs: {
                src: { default: '' },
                alt: { default: null },
                wrap: { default: null },
                width: { default: null },
                height: { default: null },
            },
            toDOM: () => ['img'],
        },
    },
})

interface BuildDocArgs {
    leadingText?: string
    imageAttrs?: Record<string, unknown>
    trailingText?: string
}

// Build a doc whose only paragraph holds an image flanked (optionally)
// by text. Returns the doc + a starting position for the image node
// so we can construct a NodeSelection that targets it.
function buildDoc(args: BuildDocArgs): { doc: Node; imagePos: number } {
    const {
        leadingText = '',
        imageAttrs = { src: 'https://example/img.png' },
        trailingText = '',
    } = args
    const children: Node[] = []
    if (leadingText) children.push(schema.text(leadingText))
    children.push(schema.nodes.image.create(imageAttrs))
    if (trailingText) children.push(schema.text(trailingText))
    const paragraph = schema.nodes.paragraph.create(null, children)
    const doc = schema.nodes.doc.create(null, [paragraph])
    let imagePos = -1
    doc.descendants((node, pos) => {
        if (node.type === schema.nodes.image && imagePos === -1) {
            imagePos = pos
        }
    })
    return { doc, imagePos }
}

// Build the editor stub deriveImageSelection consumes. The helper
// only ever reads editor.state.selection, so the rest of state can
// stay undefined.
function editorAt(selection: NodeSelection | TextSelection): EditorWithState {
    return { state: { selection } }
}

describe('deriveImageSelection', () => {
    it('returns null when no editor is passed', () => {
        expect(deriveImageSelection(null, null)).toBeNull()
        expect(deriveImageSelection(undefined, null)).toBeNull()
    })

    it('returns null when the selection is a regular text caret', () => {
        const { doc } = buildDoc({ leadingText: 'hello' })
        // TextSelection.create on a doc resolves a position and returns
        // a caret selection — the everyday "user is typing" case.
        const sel = TextSelection.create(doc, 1)
        expect(deriveImageSelection(editorAt(sel), null)).toBeNull()
    })

    it('returns null when the selection is a NodeSelection over a non-image node', () => {
        const { doc } = buildDoc({})
        // NodeSelection.create at position 0 selects the paragraph —
        // a node, but not an image, so the helper must short-circuit.
        const sel = NodeSelection.create(doc, 0)
        expect(deriveImageSelection(editorAt(sel), null)).toBeNull()
    })

    it('returns the image attrs when the selection is a NodeSelection over an image', () => {
        const { doc, imagePos } = buildDoc({
            imageAttrs: {
                src: 'https://example/photo.png',
                alt: 'A photo',
                wrap: 'left',
                width: 300,
                height: 200,
            },
        })
        const sel = NodeSelection.create(doc, imagePos)
        const result = deriveImageSelection(editorAt(sel), null)
        expect(result).not.toBeNull()
        expect(result?.src).toBe('https://example/photo.png')
        expect(result?.alt).toBe('A photo')
        expect(result?.wrap).toBe('left')
        expect(result?.width).toBe(300)
        expect(result?.height).toBe(200)
    })

    it('echoes each of the four legal wrap values (null / left / right / break)', () => {
        for (const wrap of [null, 'left', 'right', 'break'] as const) {
            const { doc, imagePos } = buildDoc({ imageAttrs: { src: 's', wrap } })
            const sel = NodeSelection.create(doc, imagePos)
            const result = deriveImageSelection(editorAt(sel), null)
            expect(result?.wrap).toBe(wrap)
        }
    })

    it('collapses an unknown wrap value to null defensively', () => {
        const { doc, imagePos } = buildDoc({ imageAttrs: { src: 's', wrap: 'mystery' } })
        const sel = NodeSelection.create(doc, imagePos)
        const result = deriveImageSelection(editorAt(sel), null)
        expect(result?.wrap).toBeNull()
    })

    it('treats missing alt as null and an empty string alt as null', () => {
        const cases: { in: unknown; out: string | null }[] = [
            { in: undefined, out: null },
            { in: null, out: null },
            { in: '', out: null },
            { in: 'A photo', out: 'A photo' },
        ]
        for (const c of cases) {
            const { doc, imagePos } = buildDoc({ imageAttrs: { src: 's', alt: c.in } })
            const sel = NodeSelection.create(doc, imagePos)
            const result = deriveImageSelection(editorAt(sel), null)
            expect(result?.alt).toBe(c.out)
        }
    })

    it('reports naturalWidth=0 and rect=null when no view is provided (image not yet rendered)', () => {
        // Production passes editor.view; tests pass null. Same null path
        // also fires in production when the image element hasn't been
        // laid out yet (view.nodeDOM returns null mid-mount). The
        // bottom sheet treats naturalWidth=0 as "Loading image…" and
        // disables the Size section.
        const { doc, imagePos } = buildDoc({ imageAttrs: { src: 's', width: 100 } })
        const sel = NodeSelection.create(doc, imagePos)
        const result = deriveImageSelection(editorAt(sel), null)
        expect(result?.naturalWidth).toBe(0)
        expect(result?.naturalHeight).toBe(0)
        expect(result?.rect).toBeNull()
    })

    it('rounds numeric width/height attrs to integers', () => {
        const { doc, imagePos } = buildDoc({
            imageAttrs: { src: 's', width: 300.6, height: 199.4 },
        })
        const sel = NodeSelection.create(doc, imagePos)
        const result = deriveImageSelection(editorAt(sel), null)
        expect(result?.width).toBe(301)
        expect(result?.height).toBe(199)
    })

    it('treats zero / negative width/height as null', () => {
        const { doc, imagePos } = buildDoc({
            imageAttrs: { src: 's', width: 0, height: -10 },
        })
        const sel = NodeSelection.create(doc, imagePos)
        const result = deriveImageSelection(editorAt(sel), null)
        expect(result?.width).toBeNull()
        expect(result?.height).toBeNull()
    })

    it('returns empty src string when src attr is missing (defensive)', () => {
        // The image node has src: { default: '' } in the schema, so
        // creating with no src lands at empty string. Echoing it
        // verbatim keeps the wire shape stable.
        const { doc, imagePos } = buildDoc({ imageAttrs: {} })
        const sel = NodeSelection.create(doc, imagePos)
        const result = deriveImageSelection(editorAt(sel), null)
        expect(result?.src).toBe('')
    })
})
