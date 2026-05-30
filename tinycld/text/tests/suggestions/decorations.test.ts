import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { EditorState } from 'prosemirror-state'
import { DecorationSet } from 'prosemirror-view'
import { describe, expect, it } from 'vitest'
import { buildSuggestionEditorExtensions } from '~/tinycld/text/lib/suggestions/build-extensions'
import {
    createSuggestionDecorationsPlugin,
    getSuggestionDecorations,
} from '~/tinycld/text/lib/suggestions/decorations'

// Build a state with a single paragraph containing one text node whose
// marks are the ones supplied. Mirrors the command-layer test's
// makeStateWithText helper but layered for direct mark control.
function makeStateWithMarkedText(
    text: string,
    markSpecs: Array<{ name: string; attrs: Record<string, unknown> }>
) {
    const schema = getSchema([StarterKit, ...buildSuggestionEditorExtensions()])
    const marks = markSpecs.map(({ name, attrs }) => schema.marks[name].create(attrs))
    const textNode = schema.text(text, marks)
    const docNode = schema.nodes.doc.create({}, schema.nodes.paragraph.create({}, textNode))
    return EditorState.create({
        doc: docNode,
        schema,
        plugins: [createSuggestionDecorationsPlugin()],
    })
}

describe('SuggestionDecorations', () => {
    it('emits an insert decoration for a suggestedInsert mark', () => {
        const state = makeStateWithMarkedText('proposed addition', [
            {
                name: 'suggestedInsert',
                attrs: { suggestionId: 's1', authorId: 'uo_alice', ts: 1000 },
            },
        ])
        const decoSet = getSuggestionDecorations(state)
        const decos = decoSet.find()
        const insertDeco = decos.find(d => d.spec?.kind === 'suggestedInsert')
        expect(insertDeco).toBeDefined()
        expect(insertDeco?.spec?.suggestionId).toBe('s1')
    })

    it('emits a delete decoration for a suggestedDelete mark', () => {
        const state = makeStateWithMarkedText('proposed deletion', [
            {
                name: 'suggestedDelete',
                attrs: { suggestionId: 's2', authorId: 'uo_bob', ts: 2000 },
            },
        ])
        const decoSet = getSuggestionDecorations(state)
        const decos = decoSet.find()
        const deleteDeco = decos.find(d => d.spec?.kind === 'suggestedDelete')
        expect(deleteDeco).toBeDefined()
        expect(deleteDeco?.spec?.suggestionId).toBe('s2')
    })

    it('emits two decorations for layered marks (Case 2b)', () => {
        const state = makeStateWithMarkedText('contested', [
            {
                name: 'suggestedInsert',
                attrs: { suggestionId: 's-ins', authorId: 'uo_alice', ts: 1000 },
            },
            {
                name: 'suggestedDelete',
                attrs: { suggestionId: 's-del', authorId: 'uo_bob', ts: 2000 },
            },
        ])
        const decoSet = getSuggestionDecorations(state)
        const decos = decoSet.find()
        const kinds = decos.map(d => d.spec?.kind).sort()
        expect(kinds).toContain('suggestedInsert')
        expect(kinds).toContain('suggestedDelete')
    })

    it('emits no decorations for unmarked text', () => {
        const schema = getSchema([StarterKit, ...buildSuggestionEditorExtensions()])
        const docNode = schema.nodes.doc.create(
            {},
            schema.nodes.paragraph.create({}, schema.text('plain text'))
        )
        const state = EditorState.create({
            doc: docNode,
            schema,
            plugins: [createSuggestionDecorationsPlugin()],
        })
        const decoSet = getSuggestionDecorations(state)
        expect(decoSet.find()).toHaveLength(0)
    })

    // Perf gating: the dominant cost concern is that the plugin walks
    // state.doc.descendants(...) on every docChanged transaction. For
    // a doc with NO suggestion content, every keystroke pays an O(n)
    // walk that produces an empty DecorationSet. The gate short-
    // circuits that path: when the existing set is empty AND the
    // transaction doesn't introduce a suggestion-relevant step, the
    // apply() returns DecorationSet.empty without re-walking.
    //
    // We assert the gate by inserting a spy around buildDecorations:
    // run the plugin, type a character into an unmarked doc, and
    // verify the apply() neither walks the doc nor re-renders. We
    // can't easily spy on the internal function (it's module-private),
    // so we instead assert the OBSERVABLE behaviour: after typing in
    // a clean doc, the decoration set is the SAME identity as before
    // (DecorationSet.empty is a singleton, so === holds).
    describe('perf gate', () => {
        // Tiny helper to apply a synthetic insert-text transaction
        // through the plugin and inspect the post-state's decoration
        // set. Mirrors what y-prosemirror would dispatch for a real
        // keystroke.
        function applyInsertText(state: EditorState, text: string): EditorState {
            const tr = state.tr.insertText(text, state.doc.content.size - 1)
            return state.apply(tr)
        }

        it('clean doc + insert text → no full walk, set stays empty singleton', () => {
            const schema = getSchema([StarterKit, ...buildSuggestionEditorExtensions()])
            const docNode = schema.nodes.doc.create(
                {},
                schema.nodes.paragraph.create({}, schema.text('plain text'))
            )
            const state = EditorState.create({
                doc: docNode,
                schema,
                plugins: [createSuggestionDecorationsPlugin()],
            })
            const beforeSet = getSuggestionDecorations(state)
            expect(beforeSet.find()).toHaveLength(0)

            // Type another character — the kind of transaction the
            // gate is supposed to short-circuit.
            const after = applyInsertText(state, 'x')
            const afterSet = getSuggestionDecorations(after)

            // Stays empty, AND is the DecorationSet.empty singleton
            // (proves the fast path returned without re-walking).
            expect(afterSet.find()).toHaveLength(0)
            expect(afterSet).toBe(DecorationSet.empty)
        })

        it('doc with existing suggestion + insert text → re-walks (set carries the surviving deco)', () => {
            // When the doc already carries a suggestion, the gate must
            // NOT short-circuit — the existing decoration's position
            // can be invalidated by the insert and must be rebuilt.
            const schema = getSchema([StarterKit, ...buildSuggestionEditorExtensions()])
            const insertMark = schema.marks.suggestedInsert.create({
                suggestionId: 's_pre',
                authorId: 'uo_alice',
                ts: 1,
            })
            const marked = schema.text('marked', [insertMark])
            const plain = schema.text(' plain')
            const docNode = schema.nodes.doc.create(
                {},
                schema.nodes.paragraph.create({}, [marked, plain])
            )
            const state = EditorState.create({
                doc: docNode,
                schema,
                plugins: [createSuggestionDecorationsPlugin()],
            })
            const before = getSuggestionDecorations(state)
            expect(before.find()).toHaveLength(1)
            const beforeSpec = before.find()[0].spec

            // Insert a character INSIDE the plain portion — the
            // suggestion mark on "marked" should still surface in
            // the decoration set after the rebuild.
            const after = applyInsertText(state, 'x')
            const afterSet = getSuggestionDecorations(after)
            expect(afterSet.find()).toHaveLength(1)
            expect(afterSet.find()[0].spec?.suggestionId).toBe(beforeSpec?.suggestionId)
            // Not the empty singleton — proves the walk DID run.
            expect(afterSet).not.toBe(DecorationSet.empty)
        })

        it('clean doc + step that adds a suggestion mark → re-walks (decoration surfaces)', () => {
            const schema = getSchema([StarterKit, ...buildSuggestionEditorExtensions()])
            const docNode = schema.nodes.doc.create(
                {},
                schema.nodes.paragraph.create({}, schema.text('hello'))
            )
            const state = EditorState.create({
                doc: docNode,
                schema,
                plugins: [createSuggestionDecorationsPlugin()],
            })
            expect(getSuggestionDecorations(state).find()).toHaveLength(0)

            const mark = schema.marks.suggestedDelete.create({
                suggestionId: 's_new',
                authorId: 'uo_alice',
                ts: 1,
            })
            const tr = state.tr.addMark(1, 1 + 'hello'.length, mark)
            const after = state.apply(tr)
            const afterSet = getSuggestionDecorations(after)
            expect(afterSet.find()).toHaveLength(1)
            expect(afterSet.find()[0].spec?.kind).toBe('suggestedDelete')
        })
    })
})
