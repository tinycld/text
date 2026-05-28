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

describe('buildSuggestionEditorExtensions with options', () => {
    it('includes the command layer when no options are supplied (inert form)', () => {
        const ext = buildSuggestionEditorExtensions()
        expect(ext).toHaveLength(4)
    })

    it('includes a configured command layer when modeStore + yDoc are supplied', async () => {
        const Y = await import('yjs')
        const { createEditorModeStore } = await import('~/tinycld/text/stores/editor-mode-store')
        const modeStore = createEditorModeStore()
        const yDoc = new Y.Doc()
        const ext = buildSuggestionEditorExtensions({ modeStore, yDoc })
        expect(ext).toHaveLength(4)
    })
})
