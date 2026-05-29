import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { EditorState } from 'prosemirror-state'
import { describe, expect, it } from 'vitest'
import { buildSuggestionEditorExtensions } from '~/tinycld/text/lib/suggestions/build-extensions'
import { extractBlockChanges } from '~/tinycld/text/lib/suggestions/block-change-utils'

// Build an EditorState whose doc is a single paragraph with the given
// text. Used by the lower-level cases.
function paragraphState(text: string) {
    const schema = getSchema([StarterKit, ...buildSuggestionEditorExtensions()])
    const docNode = schema.nodes.doc.create(
        {},
        schema.nodes.paragraph.create({}, schema.text(text))
    )
    return EditorState.create({ doc: docNode, schema })
}

// Build a state with N paragraphs, each carrying the corresponding
// text. Useful for delete-spans-multiple-blocks coverage.
function multiParagraphState(texts: string[]) {
    const schema = getSchema([StarterKit, ...buildSuggestionEditorExtensions()])
    const paragraphs = texts.map(t => schema.nodes.paragraph.create({}, schema.text(t)))
    const docNode = schema.nodes.doc.create({}, paragraphs)
    return EditorState.create({ doc: docNode, schema })
}

describe('extractBlockChanges', () => {
    it('returns a single attr entry for a setNodeAttribute on a heading', () => {
        // Build a heading-level doc so the attr we're setting (level)
        // is a real heading attribute.
        const schema = getSchema([StarterKit, ...buildSuggestionEditorExtensions()])
        const docNode = schema.nodes.doc.create(
            {},
            schema.nodes.heading.create({ level: 1 }, schema.text('title'))
        )
        const state = EditorState.create({ doc: docNode, schema })
        const tr = state.tr.setNodeAttribute(0, 'level', 2)
        const changes = extractBlockChanges(tr, state)
        expect(changes).toHaveLength(1)
        const change = changes[0]
        expect(change.kind).toBe('attr')
        if (change.kind !== 'attr') throw new Error('narrow')
        expect(change.pos).toBe(0)
        expect(change.beforeType).toBe('heading')
        expect(change.afterType).toBe('heading')
        expect(change.beforeAttrs.level).toBe(1)
        expect(change.afterAttrs.level).toBe(2)
    })

    it("returns a type-swap entry for setBlockType('heading') on a paragraph", () => {
        const state = paragraphState('hello')
        const headingType = state.schema.nodes.heading
        const tr = state.tr.setBlockType(0, state.doc.content.size, headingType, { level: 2 })
        const changes = extractBlockChanges(tr, state)
        expect(changes).toHaveLength(1)
        const change = changes[0]
        expect(change.kind).toBe('type-swap')
        if (change.kind !== 'type-swap') throw new Error('narrow')
        expect(change.beforeType).toBe('paragraph')
        expect(change.afterType).toBe('heading')
        expect(change.afterAttrs.level).toBe(2)
    })

    it('returns an empty array for a text-only edit', () => {
        const state = paragraphState('hello world')
        const tr = state.tr.insertText('!', state.doc.content.size - 1)
        const changes = extractBlockChanges(tr, state)
        expect(changes).toEqual([])
    })

    it('returns an empty array for a mark-only toggle (handled by format-change path)', () => {
        const state = paragraphState('hello world')
        const boldType = state.schema.marks.bold
        const tr = state.tr.addMark(1, 6, boldType.create())
        const changes = extractBlockChanges(tr, state)
        expect(changes).toEqual([])
    })

    it('returns one delete entry per fully-deleted block when spanning multiple blocks', () => {
        const state = multiParagraphState(['alpha', 'beta', 'gamma'])
        // Doc positions:
        //   pos 0   : <doc>
        //   pos 0   : <p>alpha</p>  size = 7 (open + 5 + close)
        //   pos 7   : <p>beta</p>   size = 6 (open + 4 + close)
        //   pos 13  : <p>gamma</p>  size = 7
        //
        // Delete [0, 13) — fully removes the first two paragraphs.
        const tr = state.tr.delete(0, 13)
        const changes = extractBlockChanges(tr, state)
        expect(changes).toHaveLength(2)
        expect(changes.every(c => c.kind === 'delete')).toBe(true)
        expect(changes[0].pos).toBe(0)
        expect(changes[1].pos).toBe(7)
        expect(changes[0].beforeType).toBe('paragraph')
        expect(changes[1].beforeType).toBe('paragraph')
    })

    it('returns a delete entry when removing a single full block', () => {
        const state = multiParagraphState(['alpha', 'beta'])
        // Delete just the first paragraph [0, 7).
        const tr = state.tr.delete(0, 7)
        const changes = extractBlockChanges(tr, state)
        expect(changes).toHaveLength(1)
        expect(changes[0].kind).toBe('delete')
        expect(changes[0].pos).toBe(0)
    })

    it('skips AttrStep targeting the suggestedBlockChange attribute itself', () => {
        // The resolve layer will write directly to suggestedBlockChange.
        // The detector must not loop those back as fresh block changes.
        const state = paragraphState('hello')
        const tr = state.tr.setNodeAttribute(0, 'suggestedBlockChange', {
            suggestionId: 'x',
            authorId: 'a',
            ts: 1,
            before: { type: 'paragraph', attrs: {} },
            after: { type: 'paragraph', attrs: {} },
        })
        const changes = extractBlockChanges(tr, state)
        expect(changes).toEqual([])
    })

    it('does NOT mistake a text-only ReplaceStep for a block delete', () => {
        const state = paragraphState('hello world')
        // Delete a couple of inner characters: positions 1..3 are
        // inside the paragraph, NOT enclosing it.
        const tr = state.tr.delete(1, 3)
        const changes = extractBlockChanges(tr, state)
        expect(changes).toEqual([])
    })
})
