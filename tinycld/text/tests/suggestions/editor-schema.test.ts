import { getSchema } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { buildEditorExtensions } from '~/tinycld/text/webview-editor/source/Editor'

describe('editor schema with suggestion extensions', () => {
    const schema = getSchema(buildEditorExtensions())

    it('includes suggestedInsert mark', () => {
        expect(schema.marks.suggestedInsert).toBeDefined()
    })

    it('includes suggestedDelete mark', () => {
        expect(schema.marks.suggestedDelete).toBeDefined()
    })

    it('paragraph node has suggestedBlockChange attribute', () => {
        const paraSpec = schema.nodes.paragraph.spec
        expect(paraSpec.attrs?.suggestedBlockChange).toBeDefined()
    })
})
