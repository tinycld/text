// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createEditEventsBridge } from '~/tinycld/text/hooks/use-edit-events'

describe('createEditEventsBridge', () => {
    it('returns an empty array when the editEvents Y.Array is empty', () => {
        const yDoc = new Y.Doc()
        const bridge = createEditEventsBridge(yDoc)
        const snap = bridge.getSnapshot()
        expect(snap).toEqual([])
    })

    it('returns a single parsed EditEvent when one entry is present', () => {
        const yDoc = new Y.Doc()
        const arr = yDoc.getArray<unknown>('editEvents')
        arr.push([
            {
                clientId: 42,
                authorId: 'uo-A',
                startedAt: 1000,
                endedAt: 2000,
                editCount: 3,
                affectedNodes: [{ nodeId: 'p1', snippet: 'hello' }],
            },
        ])
        const bridge = createEditEventsBridge(yDoc)
        const snap = bridge.getSnapshot()
        expect(snap).toHaveLength(1)
        expect(snap[0].clientId).toBe(42)
        expect(snap[0].authorId).toBe('uo-A')
        expect(snap[0].editCount).toBe(3)
        expect(snap[0].affectedNodes).toEqual([{ nodeId: 'p1', snippet: 'hello' }])
    })

    it('sorts events by endedAt descending', () => {
        const yDoc = new Y.Doc()
        const arr = yDoc.getArray<unknown>('editEvents')
        arr.push([
            {
                clientId: 1,
                authorId: 'uo-A',
                startedAt: 100,
                endedAt: 200,
                editCount: 1,
                affectedNodes: [],
            },
            {
                clientId: 2,
                authorId: 'uo-B',
                startedAt: 500,
                endedAt: 600,
                editCount: 1,
                affectedNodes: [],
            },
            {
                clientId: 3,
                authorId: 'uo-C',
                startedAt: 300,
                endedAt: 400,
                editCount: 1,
                affectedNodes: [],
            },
        ])
        const bridge = createEditEventsBridge(yDoc)
        const snap = bridge.getSnapshot()
        expect(snap.map(e => e.endedAt)).toEqual([600, 400, 200])
        expect(snap.map(e => e.clientId)).toEqual([2, 3, 1])
    })
})
