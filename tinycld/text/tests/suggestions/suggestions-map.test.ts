import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { SuggestionsMap } from '~/tinycld/text/lib/suggestions/suggestions-map'
import {
    SUGGESTION_STATUS_ACCEPTED,
    SUGGESTION_STATUS_OPEN,
} from '~/tinycld/text/webview-editor/source/suggestions/suggestion-types'

describe('SuggestionsMap', () => {
    it('writes a new suggestion entry', () => {
        const doc = new Y.Doc()
        const map = new SuggestionsMap(doc)
        map.create({ id: 's1', authorId: 'uo_alice', createdAt: 1000 })
        const got = map.get('s1')
        expect(got).toMatchObject({
            id: 's1',
            authorId: 'uo_alice',
            createdAt: 1000,
            status: SUGGESTION_STATUS_OPEN,
        })
    })

    it('idempotent create — second create on same id is a no-op', () => {
        const doc = new Y.Doc()
        const map = new SuggestionsMap(doc)
        map.create({ id: 's1', authorId: 'uo_alice', createdAt: 1000 })
        map.create({ id: 's1', authorId: 'uo_bob', createdAt: 2000 })
        expect(map.get('s1')?.authorId).toBe('uo_alice') // first write wins
    })

    it('resolve sets status, resolvedBy, resolvedAt', () => {
        const doc = new Y.Doc()
        const map = new SuggestionsMap(doc)
        map.create({ id: 's1', authorId: 'uo_alice', createdAt: 1000 })
        map.resolve('s1', { status: SUGGESTION_STATUS_ACCEPTED, by: 'uo_carol', at: 5000 })
        const got = map.get('s1')
        expect(got?.status).toBe(SUGGESTION_STATUS_ACCEPTED)
        expect(got?.resolvedBy).toBe('uo_carol')
        expect(got?.resolvedAt).toBe(5000)
    })

    it('resolve on missing suggestionId throws', () => {
        const doc = new Y.Doc()
        const map = new SuggestionsMap(doc)
        expect(() =>
            map.resolve('missing', {
                status: SUGGESTION_STATUS_ACCEPTED,
                by: 'uo_carol',
                at: 5000,
            })
        ).toThrow(/not found/)
    })

    it('list returns all entries', () => {
        const doc = new Y.Doc()
        const map = new SuggestionsMap(doc)
        map.create({ id: 's1', authorId: 'uo_alice', createdAt: 1000 })
        map.create({ id: 's2', authorId: 'uo_bob', createdAt: 2000 })
        const list = map.list()
        expect(list).toHaveLength(2)
        expect(list.map(s => s.id).sort()).toEqual(['s1', 's2'])
    })

    it('observe fires on create', () => {
        const doc = new Y.Doc()
        const map = new SuggestionsMap(doc)
        let fired = 0
        map.observe(() => {
            fired++
        })
        map.create({ id: 's1', authorId: 'uo_alice', createdAt: 1000 })
        expect(fired).toBe(1)
    })

    it('observe fires on resolve', () => {
        const doc = new Y.Doc()
        const map = new SuggestionsMap(doc)
        map.create({ id: 's1', authorId: 'uo_alice', createdAt: 1000 })
        let fired = 0
        map.observe(() => {
            fired++
        })
        map.resolve('s1', { status: SUGGESTION_STATUS_ACCEPTED, by: 'uo_carol', at: 5000 })
        expect(fired).toBe(1)
    })

    it('delete removes the entry; idempotent on absent ids', () => {
        const doc = new Y.Doc()
        const map = new SuggestionsMap(doc)
        map.create({ id: 's1', authorId: 'uo_alice', createdAt: 1000 })
        expect(map.get('s1')).toBeDefined()
        map.delete('s1')
        expect(map.get('s1')).toBeUndefined()
        map.delete('s1')
        map.delete('never-existed')
        expect(map.list()).toHaveLength(0)
    })

    it('deleteMany batches into a single Yjs transaction', () => {
        const doc = new Y.Doc()
        const map = new SuggestionsMap(doc)
        map.create({ id: 's1', authorId: 'uo_alice', createdAt: 1000 })
        map.create({ id: 's2', authorId: 'uo_bob', createdAt: 2000 })
        map.create({ id: 's3', authorId: 'uo_carol', createdAt: 3000 })
        // A single transaction wrapping three deletes fires the
        // observer once; three bare delete()s would fire it three times.
        let fired = 0
        map.observe(() => {
            fired++
        })
        map.deleteMany(['s1', 's2', 's3'], doc)
        expect(fired).toBe(1)
        expect(map.list()).toHaveLength(0)
    })

    it('deleteMany on empty list is a no-op', () => {
        const doc = new Y.Doc()
        const map = new SuggestionsMap(doc)
        map.create({ id: 's1', authorId: 'uo_alice', createdAt: 1000 })
        let fired = 0
        map.observe(() => {
            fired++
        })
        map.deleteMany([], doc)
        expect(fired).toBe(0)
        expect(map.get('s1')).toBeDefined()
    })
})
