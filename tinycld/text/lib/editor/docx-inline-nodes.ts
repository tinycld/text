import { Node } from '@tiptap/core'

// Inline nodes the .docx importer (server/translate, docx_to_pm_walk.go)
// writes into the shared document. Every node type the server seeds must
// exist in the editor schema: the Yjs binding refuses a document that holds
// an unknown node, and the editor then shows nothing and cannot be edited.
// Both editor mounts (web and the native WebView) list these, so they share
// one schema.

// PageBreak is Word's hard page break (<w:br w:type="page"/>). The export
// writes it back as a page break; the editor shows a dashed rule.
export const PageBreak = Node.create({
    name: 'pageBreak',
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,
    parseHTML() {
        return [{ tag: 'span[data-page-break]' }]
    },
    renderHTML() {
        return ['span', { 'data-page-break': '', class: 'tinycld-text-page-break' }]
    },
})

// A footnote or endnote reference. `id` is the note's id in the .docx and
// `text` its flattened body, which the reference shows as a tooltip.
function noteReference(name: string, kind: string) {
    return Node.create({
        name,
        group: 'inline',
        inline: true,
        atom: true,
        selectable: true,
        addAttributes() {
            return {
                id: { default: null },
                text: { default: null },
            }
        },
        parseHTML() {
            return [{ tag: `sup[data-${kind}-ref]` }]
        },
        renderHTML({ node }) {
            return [
                'sup',
                {
                    [`data-${kind}-ref`]: node.attrs.id ?? '',
                    class: `tinycld-text-${kind}-ref`,
                    title: node.attrs.text ?? '',
                },
                `[${node.attrs.id ?? '?'}]`,
            ]
        },
    })
}

export const FootnoteReference = noteReference('footnoteReference', 'footnote')
export const EndnoteReference = noteReference('endnoteReference', 'endnote')

export const DOCX_INLINE_NODES = [PageBreak, FootnoteReference, EndnoteReference]
