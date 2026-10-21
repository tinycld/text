import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSchema } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { buildEditorExtensions } from '~/tinycld/text/webview-editor/source/Editor'

// The server seeds the shared document from a .docx with the node types in
// server/translate/types.go. The Yjs binding refuses a document that holds a
// node the editor schema lacks: the editor then shows nothing and cannot be
// edited. So the schema must have every node type the server can write.
function serverNodeTypes(): string[] {
    const source = readFileSync(
        join(import.meta.dirname, '../../../../server/translate/types.go'),
        'utf8'
    )
    return [...source.matchAll(/\bNodeType\w+\s*=\s*"(\w+)"/g)].map(match => match[1])
}

describe('editor schema and the .docx importer', () => {
    const schema = getSchema(buildEditorExtensions())

    it('has every node type the server writes', () => {
        const types = serverNodeTypes()
        expect(types).toContain('pageBreak')
        for (const type of types) expect(schema.nodes[type], type).toBeDefined()
    })

    it('accepts a page break and note references inside a paragraph', () => {
        const node = schema.nodeFromJSON({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'Before' },
                        { type: 'pageBreak' },
                        { type: 'footnoteReference', attrs: { id: '1', text: 'A note' } },
                        { type: 'endnoteReference', attrs: { id: '2' } },
                    ],
                },
            ],
        })
        expect(() => node.check()).not.toThrow()
        expect(node.firstChild?.child(2).attrs).toEqual({ id: '1', text: 'A note' })
    })
})
