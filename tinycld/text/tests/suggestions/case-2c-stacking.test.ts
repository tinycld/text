import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { describe, expect, it } from 'vitest'
import { buildSuggestionEditorExtensions } from '~/tinycld/text/lib/suggestions/build-extensions'

const schema = getSchema([StarterKit, ...buildSuggestionEditorExtensions()])

describe('Case 2c — same-type suggestion marks stack', () => {
    it('two suggestedDelete marks from different users coexist on the same text', () => {
        const m1 = schema.marks.suggestedDelete.create({
            suggestionId: 's-bob',
            authorId: 'uo_bob',
            ts: 1000,
        })
        const m2 = schema.marks.suggestedDelete.create({
            suggestionId: 's-carol',
            authorId: 'uo_carol',
            ts: 2000,
        })
        // Use Mark.addToSet — this is the path ProseMirror takes when
        // a transaction's addMark step layers a new mark onto an
        // existing range. It honors the schema's `excludes` config,
        // unlike `schema.text(content, marks)` which just stores the
        // raw array. Default behavior (`excludes` unset → excludes
        // self) collapses these to one; spec Case 2c requires both
        // suggestionIds to survive.
        const set = m2.addToSet(m1.addToSet([]))
        const text = schema.text('deletion-target', set)
        const dels = text.marks.filter((m) => m.type.name === 'suggestedDelete')
        const names = dels.map((m) => m.attrs.authorId)
        expect(names).toContain('uo_bob')
        expect(names).toContain('uo_carol')
        expect(dels).toHaveLength(2)
    })

    it('two suggestedInsert marks from different users coexist on the same text', () => {
        const m1 = schema.marks.suggestedInsert.create({
            suggestionId: 's-alice',
            authorId: 'uo_alice',
            ts: 1000,
        })
        const m2 = schema.marks.suggestedInsert.create({
            suggestionId: 's-dave',
            authorId: 'uo_dave',
            ts: 2000,
        })
        const set = m2.addToSet(m1.addToSet([]))
        const text = schema.text('contested-insertion', set)
        expect(text.marks.filter((m) => m.type.name === 'suggestedInsert')).toHaveLength(2)
    })

    it('an insert mark and a delete mark still coexist (Phase 2a Case 2b regression check)', () => {
        const ins = schema.marks.suggestedInsert.create({
            suggestionId: 's-ins',
            authorId: 'uo_alice',
            ts: 1000,
        })
        const del = schema.marks.suggestedDelete.create({
            suggestionId: 's-del',
            authorId: 'uo_bob',
            ts: 2000,
        })
        const set = del.addToSet(ins.addToSet([]))
        const text = schema.text('contested', set)
        expect(text.marks).toHaveLength(2)
    })
})
