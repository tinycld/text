import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AwarenessWebViewHost } from '@tinycld/core/lib/editor/rich/awareness-webview-host'
import { YjsWebViewHost } from '@tinycld/core/lib/editor/rich/yjs-webview-host'
import { describe, expect, it, vi } from 'vitest'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import * as Y from 'yjs'

/** Make `target` see `source`'s local state, the way the wire would. */
function applyRemote(target: Awareness, source: Awareness) {
    applyAwarenessUpdate(target, encodeAwarenessUpdate(source, [source.clientID]), 'test')
}

/**
 * The native document editor relays the room's Y.Doc and Awareness into the
 * WebView instead of letting the page open a connection of its own.
 *
 * Core covers the host classes themselves. What was uncovered — and what this
 * file pins — is the text-side contract that makes the relay the ONLY path:
 * the page is never handed credentials, and the relay tears down with the
 * surface that opened it.
 */

const nativeHook = readFileSync(
    join(__dirname, '../tinycld/text/hooks/use-document-editor.native.tsx'),
    'utf8'
)

describe('the WebView cannot open its own socket', () => {
    /**
     * Structural, deliberately. The page used to receive baseURL/roomKind/
     * roomId/token in its init payload and construct a RealtimeClient — a
     * SECOND socket onto the same room, so every update applied twice and the
     * local user appeared as two peers in the presence row.
     *
     * Deleting the client is not what makes that unreachable; withholding the
     * URL and the credential is. A test that mounted the hook could not observe
     * this — the absence of a field is not a runtime event — so it is asserted
     * against the source that builds the payload.
     */
    it.each(['baseURL', 'roomKind', 'token'])('does not hand the page %s', field => {
        expect(nativeHook).not.toMatch(new RegExp(`^\\s*${field}:`, 'm'))
    })

    it('does not import a realtime client', () => {
        expect(nativeHook).not.toMatch(/RealtimeClient/)
    })
})

describe('relay lifecycle', () => {
    it('stops relaying doc updates once destroyed', () => {
        const doc = new Y.Doc()
        const postMessage = vi.fn(() => true)
        const host = new YjsWebViewHost({ doc, postMessage })

        doc.getXmlFragment('prosemirror').insert(0, [new Y.XmlText('hello')])
        expect(postMessage).toHaveBeenCalled()

        host.destroy()
        postMessage.mockClear()

        // An edit after teardown must not reach a page that is gone. Without
        // the unmount cleanup the observer stays subscribed to a live Y.Doc for
        // the lifetime of the room.
        doc.getXmlFragment('prosemirror').insert(0, [new Y.XmlText('more')])
        expect(postMessage).not.toHaveBeenCalled()
    })

    it('stops relaying awareness updates once destroyed', () => {
        const doc = new Y.Doc()
        const awareness = new Awareness(doc)
        const postMessage = vi.fn(() => true)
        const host = new AwarenessWebViewHost({ awareness, postMessage })

        host.destroy()
        postMessage.mockClear()

        awareness.setLocalStateField('user', { name: 'Ada' })
        expect(postMessage).not.toHaveBeenCalled()
    })

    /**
     * The doubled-presence half of the same bug. The page has a clientID of its
     * own, and relaying the local slot back and forth made one person show up
     * as two avatars.
     */
    it('never relays the local awareness slot', () => {
        const doc = new Y.Doc()
        const awareness = new Awareness(doc)
        const postMessage = vi.fn(() => true)
        const host = new AwarenessWebViewHost({ awareness, postMessage })

        // The local user's own cursor moving must not be posted to the page:
        // the page has a clientID of its own, and echoing the local slot into
        // it made one person appear as two avatars.
        awareness.setLocalStateField('user', { name: 'Ada' })

        expect(postMessage).not.toHaveBeenCalled()

        // A remote peer's state does travel. A separate Y.Doc, so the peer gets
        // a clientID of its own — two Awareness over one doc share it, which
        // would make the "remote" peer indistinguishable from the local slot.
        const remote = new Awareness(new Y.Doc())
        remote.setLocalStateField('user', { name: 'Grace' })
        applyRemote(awareness, remote)

        expect(postMessage).toHaveBeenCalled()

        host.destroy()
        remote.destroy()
    })
})
