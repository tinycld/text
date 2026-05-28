import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { describe, expect, it } from 'vitest'
import { buildSuggestionEditorExtensions } from '~/tinycld/text/lib/suggestions/build-extensions'

describe('buildSuggestionEditorExtensions', () => {
    const schema = getSchema([StarterKit, ...buildSuggestionEditorExtensions()])

    it('registers suggestedInsert mark', () => {
        expect(schema.marks.suggestedInsert).toBeDefined()
    })

    it('registers suggestedDelete mark', () => {
        expect(schema.marks.suggestedDelete).toBeDefined()
    })

    it('registers suggestedBlockChange attr on paragraph', () => {
        expect(schema.nodes.paragraph.spec.attrs?.suggestedBlockChange).toBeDefined()
    })
})
