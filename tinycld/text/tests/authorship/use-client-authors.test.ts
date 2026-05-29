// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createClientAuthorsBridge } from '~/tinycld/text/hooks/use-client-authors'

describe('createClientAuthorsBridge', () => {
    it('returns an empty Map when the clientAuthors Y.Map is empty', () => {
        const yDoc = new Y.Doc()
        const bridge = createClientAuthorsBridge(yDoc)
        const snap = bridge.getSnapshot()
        expect(snap).toBeInstanceOf(Map)
        expect(snap.size).toBe(0)
    })

    it('round-trips a single entry with a numeric clientID key', () => {
        const yDoc = new Y.Doc()
        const map = yDoc.getMap<string>('clientAuthors')
        map.set('42', 'uo-A')
        const bridge = createClientAuthorsBridge(yDoc)
        const snap = bridge.getSnapshot()
        expect(snap.size).toBe(1)
        expect(snap.get(42)).toBe('uo-A')
    })

    it('preserves all entries when multiple clientIDs are mapped', () => {
        const yDoc = new Y.Doc()
        const map = yDoc.getMap<string>('clientAuthors')
        map.set('1', 'uo-A')
        map.set('1234567890', 'uo-B')
        map.set('999', 'uo-C')
        const bridge = createClientAuthorsBridge(yDoc)
        const snap = bridge.getSnapshot()
        expect(snap.size).toBe(3)
        expect(snap.get(1)).toBe('uo-A')
        expect(snap.get(1234567890)).toBe('uo-B')
        expect(snap.get(999)).toBe('uo-C')
    })
})
