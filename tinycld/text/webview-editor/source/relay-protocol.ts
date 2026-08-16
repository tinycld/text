// Reuse core's relay protocol rather than restating it here.
//
// This replaces the old `realtime-client.ts`, which re-exported core's
// RealtimeClient so the page could open its OWN WebSocket. It no longer does:
// the native host owns the one connection and relays over the WebView bridge,
// so the page needs the message vocabulary but no networking at all. That is
// what removed both the credential this page used to be handed and the second
// awareness identity that made one human look like two peers.
//
// These modules are DOM-free and bundle cleanly here, same as the client did.

import { type EditorMessage, makeMessage } from '@tinycld/core/lib/editor/message-bus/types'
import {
    AWARENESS_CURSOR,
    AWARENESS_LEAVE,
    AWARENESS_PEERS,
    type AwarenessLeavePayload,
    type AwarenessPeersPayload,
    decodeUpdate,
    encodeUpdate,
    YJS_UPDATE,
    type YjsUpdatePayload,
} from '@tinycld/core/lib/editor/rich/webview/source/protocol'

export {
    AWARENESS_CURSOR,
    AWARENESS_LEAVE,
    AWARENESS_PEERS,
    type AwarenessLeavePayload,
    type AwarenessPeersPayload,
    decodeUpdate,
    type EditorMessage,
    encodeUpdate,
    makeMessage,
    YJS_UPDATE,
    type YjsUpdatePayload,
}
