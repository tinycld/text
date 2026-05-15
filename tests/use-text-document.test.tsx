// useTextDocument composes useDocumentEditor (Tiptap binding) with
// the realtime room's typed slot helpers (saveStatus, readOnly,
// importWarnings). The Tiptap-driven side of the hook can't run in
// the Vitest node environment — Tiptap needs a real DOM and a
// mounted EditorView before its commands and reactive state become
// meaningful.
//
// What we DO test here are the pure narrowing helpers
// (`typedServerHello`, `typedServerSlot`) the hook composes — and
// the contract that drives the SaveStatusIndicator + read-only
// affordance. End-to-end coverage of the editor binding lands in the
// M6.20 Playwright suite.

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import type { RealtimeRoomHandle } from '@tinycld/core/lib/realtime/use-realtime-room'
import { typedServerHello, typedServerSlot } from '../tinycld/text/hooks/useTextRoom'

function makeRoom(opts: {
    serverHello?: unknown
    serverSlot?: unknown
}): RealtimeRoomHandle {
    const yDoc = new Y.Doc()
    const awareness = new Awareness(yDoc)
    return {
        doc: yDoc,
        awareness,
        isReady: true,
        isConnected: true,
        serverHello: opts.serverHello ?? null,
        serverSlot: opts.serverSlot ?? null,
    }
}

describe('typedServerHello', () => {
    it('returns a non-readOnly hello with no warnings when the room is null', () => {
        const hello = typedServerHello(null)
        expect(hello.readOnly).toBe(false)
        expect(hello.importWarnings).toEqual([])
    })

    it('returns the same defaults when the room has no hello yet', () => {
        const hello = typedServerHello(makeRoom({}))
        expect(hello.readOnly).toBe(false)
        expect(hello.importWarnings).toEqual([])
    })

    it('passes through the server payload when it is present', () => {
        const room = makeRoom({
            serverHello: {
                readOnly: true,
                importWarnings: [{ code: 'unsupported-feature' }],
            },
        })
        const hello = typedServerHello(room)
        expect(hello.readOnly).toBe(true)
        expect(hello.importWarnings).toHaveLength(1)
        expect(hello.importWarnings[0].code).toBe('unsupported-feature')
    })
})

describe('typedServerSlot', () => {
    it("defaults to 'ok' so the indicator doesn't flash failed before the first slot frame arrives", () => {
        expect(typedServerSlot(null).saveStatus).toBe('ok')
        expect(typedServerSlot(makeRoom({})).saveStatus).toBe('ok')
    })

    it("propagates 'failed' when the server reports a save failure", () => {
        const room = makeRoom({ serverSlot: { saveStatus: 'failed' } })
        expect(typedServerSlot(room).saveStatus).toBe('failed')
    })
})
