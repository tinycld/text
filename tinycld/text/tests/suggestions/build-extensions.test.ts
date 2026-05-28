import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { buildSuggestionEditorExtensions } from '~/tinycld/text/lib/suggestions/build-extensions'
import { createEditorModeStore } from '~/tinycld/text/stores/editor-mode-store'

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
        expect(ext).toHaveLength(5)
        // Inert form: the configure() call is NOT made, so the last
        // extension's .options is whatever addOptions() defaults to (null
        // shapes). Verify modeStore is falsy.
        const last = ext[4] as { options?: { modeStore?: unknown } }
        expect(last.options?.modeStore).toBeFalsy()
    })

    it('includes a configured command layer when modeStore + yDoc are supplied', () => {
        const modeStore = createEditorModeStore()
        const yDoc = new Y.Doc()
        const ext = buildSuggestionEditorExtensions({ modeStore, yDoc })
        expect(ext).toHaveLength(5)
        // Configured form: the configure() call sets options.modeStore.
        const last = ext[4] as { options?: { modeStore?: unknown } }
        expect(last.options?.modeStore).toBe(modeStore)
    })
})
