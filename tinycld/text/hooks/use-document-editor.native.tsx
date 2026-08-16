import {
    BlockquoteBridge,
    BoldBridge,
    BulletListBridge,
    CoreBridge,
    HardBreakBridge,
    HeadingBridge,
    HistoryBridge,
    ItalicBridge,
    LinkBridge,
    OrderedListBridge,
    PlaceholderBridge,
    UnderlineBridge,
} from '@10play/tentap-editor'
import { useAuth } from '@tinycld/core/lib/auth'
import type { EditorMessage } from '@tinycld/core/lib/editor/message-bus/types'
import { AwarenessWebViewHost } from '@tinycld/core/lib/editor/rich/awareness-webview-host'
import { YjsWebViewHost } from '@tinycld/core/lib/editor/rich/yjs-webview-host'
import { useWebViewEditor } from '@tinycld/core/lib/editor/use-webview-editor'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { Awareness } from 'y-protocols/awareness'
import type * as Y from 'yjs'
import { publishUiMessage } from '../lib/anchored-overlay/ui-message-bus'
import { colorForUser } from '../lib/color-for-user'
import {
    dispatchFindReplaceMessage,
    makeNativeFindReplaceController,
} from '../lib/native-find-replace-controller'
import { useFindReplaceStateStore } from '../lib/stores/find-replace-state-store'
import { useImageSelectionStore } from '../lib/stores/image-selection-store'
import type { EditorModeStore } from '../stores/editor-mode-store'
import { editorHtml } from '../webview-editor/build/editorHtml'
import type { ImageSelection } from '../webview-editor/source/editor-state-types'
import {
    createNativeCommentBridge,
    createNativeCommentBridgeState,
    dispatchCommentMessage,
} from './native-comment-bridge'
import type { DocumentEditorResult } from './use-document-editor'

export interface UseDocumentEditorOptions {
    yDoc: Y.Doc
    awareness: Awareness
    user?: { name: string; color: string }
    editable?: boolean
    placeholder?: string
    // Retained for call-site symmetry with the web hook and for the
    // suggestion bridge's room correlation. It no longer selects a
    // connection: the WebView used to open its own realtime room from
    // this id, and now the host relays over the bridge instead.
    driveItemId?: string
    // The per-document mode store. The native runtime doesn't yet
    // consume modeStore directly — the WebView's command layer reads
    // its mode through its own channel — but the local interface
    // matches the .d.ts contract so callers can pass it uniformly
    // across platforms.
    modeStore: EditorModeStore
    // Forwarded to useWebViewEditor. Called when the WebView's
    // suggestion list bridge posts a {kind, payload} message. The
    // screen wires this to the NativeSuggestionBridge's
    // processIncomingMessage so the review drawer's anchored/orphaned
    // snapshot stays in sync with the WebView-side editor.
    onSuggestionMessage?: (kind: string, payload: unknown) => void
}

// useDocumentEditor (native). The WebView contains a full TipTap+Yjs
// editor, bound to the room's Y.Doc and Awareness by relaying over the
// bridge on the host's existing socket.
//
// It did not always work that way. The page used to open a SECOND
// WebSocket of its own, which meant handing a live auth token into a
// WebView and — because that connection carried its own awareness
// identity — showing one human as two peers: two avatars in
// PresenceAvatars, two carets, and a slot the host's presence teardown
// could never clean up. The Y.Doc / Awareness from options were passed
// in but ignored.
//
// Now they are the editor's actual document. The host owns the one
// connection, no credential enters the page, and the local user is one
// peer. See @tinycld/core/lib/editor/rich/awareness-webview-host.
//
// We register the full set of per-feature TenTap bridges (not just
// CoreBridge). Each bridge's extendEditorInstance hook attaches its
// command method (toggleBold, toggleItalic, setLink, ...) to the
// native-side bridge object. useWebViewEditor's commands call those
// methods, so without the bridges registered, every format button
// throws "bridge.toggleBold is not a function" at runtime.
//
// The bridges' tiptapExtension fields are unused on the WebView side
// (customSource means our in-WebView React app owns its own TipTap
// configuration) — only the native-side message-emit machinery
// matters here. The emitted action-type strings (e.g. 'toggle-bold')
// must match the cases handled in webview-editor/source/Editor.tsx;
// note that TenTap emits camelCase for some list types
// ('toggle-bulletList', 'toggle-orderedList').
export function useDocumentEditor(options: UseDocumentEditorOptions): DocumentEditorResult {
    const { user } = useAuth()
    const userId = user?.id ?? ''
    const userName = user?.name ?? ''
    const userColor = userId ? colorForUser(userId) : '#999'

    // Constructed before the WebView exists, so the relays post through an
    // indirection rather than holding the poster itself. `postMessageRef` below
    // is assigned once useWebViewEditor has returned.
    const posterRef = useRef<((message: EditorMessage) => boolean) | null>(null)

    // The relays onto the room's LIVE Y.Doc and Awareness — the ones
    // `useTextRoom` already opened and this hook previously ignored. Rebuilt
    // only when their identity changes (a different document, a reconnected
    // room), because they subscribe to those objects.
    const yjsHost = useMemo(
        () =>
            new YjsWebViewHost({
                doc: options.yDoc,
                postMessage: message => posterRef.current?.(message) ?? false,
            }),
        [options.yDoc]
    )
    useEffect(() => () => yjsHost.destroy(), [yjsHost])

    const awarenessHost = useMemo(
        () =>
            new AwarenessWebViewHost({
                awareness: options.awareness,
                postMessage: message => posterRef.current?.(message) ?? false,
            }),
        [options.awareness]
    )
    useEffect(() => () => awarenessHost.destroy(), [awarenessHost])

    const initPayload = useMemo(() => {
        const peersAtHandshake = awarenessHost.encodePeers()
        return {
            user: { id: userId, name: userName, color: userColor },
            editable: options.editable ?? true,
            placeholder: options.placeholder,
            documentId: options.driveItemId ?? '',
            // Snapshotted at handshake time. Anything that arrives between now
            // and the page mounting comes through as a normal relayed update, so
            // a slightly stale seed is not a lost edit.
            initialState: yjsHost.encodeState(),
            ...(peersAtHandshake ? { peers: peersAtHandshake } : {}),
        }
    }, [
        options.editable,
        options.placeholder,
        options.driveItemId,
        userId,
        userName,
        userColor,
        yjsHost,
        awarenessHost,
    ])

    // Push image-selection events from the WebView into the shared
    // store the bottom sheet subscribes to. Every other 'ui' message
    // is fanned out to the ui-message-bus so the anchored-overlay
    // controller (and future subscribers — comments, mentions, …)
    // can consume them without each one having to thread its own
    // onUiMessage prop through the editor stack.
    //
    // Payload-narrowing is done at runtime here (not via a single
    // `as` cast) so that a future selection-kind we don't yet handle
    // (e.g. 'popover', 'comment') falls through silently rather than
    // being mis-coerced to an ImageSelection. The cast on the matched
    // branch is the narrowest possible — just the .image field after
    // we've verified kind === 'image'.
    const onUiMessage = useCallback((message: EditorMessage) => {
        if (message.type === 'selection-changed') {
            const payload = message.payload
            if (payload === null || typeof payload !== 'object') return
            if (!('kind' in payload)) return
            if (payload.kind === 'image' && 'image' in payload) {
                useImageSelectionStore.getState().setSelection(payload.image as ImageSelection)
            } else if (payload.kind === 'none') {
                useImageSelectionStore.getState().setSelection(null)
            }
            return
        }
        // Forward everything else (show-popover, popover-update,
        // popover-exited, future kinds) to the bus. The bus is
        // a process-global publisher so subscribers don't have to
        // reach up through the editor result to find a callback.
        publishUiMessage(message)
    }, [])

    // WebView scroll closes any open anchored popover. Implemented by
    // publishing a synthetic 'popover-dismiss-on-scroll' message into
    // the ui-message-bus that the controller's reducer reduces to a
    // dismiss. iOS RN-WebView doesn't surface in-document scrolls via
    // its `onScroll` when scrollEnabled=false (which TenTap sets), so
    // the WebView source posts a 'document-scroll' message and we
    // re-emit it on the bus here.
    const onScroll = useCallback(() => {
        publishUiMessage({
            namespace: 'ui',
            type: 'popover-dismiss-on-scroll',
            payload: null,
        })
    }, [])

    // Clear the store on unmount so navigating away (or remounting the
    // editor between documents) can't leave the bottom sheet stuck
    // open on a stale selection.
    useEffect(
        () => () => {
            useImageSelectionStore.getState().clearSelection()
        },
        []
    )

    // Clear the find/replace mirror store on unmount for the same
    // reason as image-selection above: switching from doc A (where the
    // user had a query producing "23 matches") to doc B without this
    // cleanup briefly shows doc A's count over doc B's content until
    // the new WebView's initial state-update broadcast lands.
    useEffect(
        () => () => {
            useFindReplaceStateStore.setState({ matchCount: 0, currentIndex: 0, query: '' })
        },
        []
    )

    // Subscriber sets + pending-request maps backing the
    // DocumentCommentBridge. Sets fan out tap/removed events to any
    // number of host handlers; the Maps correlate request/response
    // pairs across the WebView round-trip. Held in a ref because
    // nothing renders off these — they're message-bus plumbing, and
    // re-rendering on every subscribe/unsubscribe would tear down the
    // WebView.
    const commentStateRef = useRef(createNativeCommentBridgeState())

    // Fan-out for 'comment' namespace messages from the WebView. The
    // pure dispatcher in native-comment-bridge.ts handles the per-type
    // routing — narrow + resolve or call handlers.
    const onCommentMessage = useCallback((msg: EditorMessage) => {
        dispatchCommentMessage(commentStateRef.current, msg)
    }, [])

    // Fan-out for 'find-replace' namespace messages from the WebView.
    // The pure dispatcher pushes state-update payloads into the
    // host-side mirror store the FindReplaceBar reads through its
    // controller.
    const onFindReplaceMessage = useCallback((msg: EditorMessage) => {
        dispatchFindReplaceMessage(msg)
    }, [])

    // Document updates and collaborator carets from the page. Everything else
    // falls through to the handlers below.
    const relayMessage = useCallback(
        (message: EditorMessage) => {
            if (awarenessHost.handleMessage(message)) return
            yjsHost.handleMessage(message)
        },
        [yjsHost, awarenessHost]
    )

    const result = useWebViewEditor({
        editorHtml,
        bridgeExtensions: [
            CoreBridge,
            BoldBridge,
            ItalicBridge,
            UnderlineBridge,
            HeadingBridge,
            BulletListBridge,
            OrderedListBridge,
            BlockquoteBridge,
            LinkBridge,
            HistoryBridge,
            HardBreakBridge,
            PlaceholderBridge,
        ],
        initPayload,
        editable: options.editable ?? true,
        onUiMessage,
        onScroll,
        onCommentMessage,
        onFindReplaceMessage,
        onSuggestionMessage: options.onSuggestionMessage,
        onMessage: relayMessage,
    })

    // Close the loop: the relays were built before the WebView existed, so this
    // is where they get a real poster. Absent until the bridge is up, which the
    // relays already treat as "not sent" rather than an error.
    posterRef.current = result.postMessage ?? null

    // postMessage isn't ref-stable (it depends on the bridge identity)
    // but we want the commentBridge to be a stable identity across
    // renders. Pin the latest poster behind a ref and read through it
    // inside the bridge methods. Consumers (TextCommentDrawer, the
    // new-comment flow) put the bridge in effect dep arrays — a fresh
    // identity each render would re-subscribe their handlers needlessly.
    const postMessageRef = useRef(result.postMessage)
    postMessageRef.current = result.postMessage

    // Gate the comment bridge on the WebView's TenTap-ready signal.
    // Before isReady flips true the WebView's postMessage either no-ops
    // (no .current ref yet) or its on-message listener inside the
    // WebView hasn't installed — either way, a tap on "+comment" in
    // that window would silently drop the request. Returning null here
    // lets call sites (TextCommentDrawer, the new-comment flow) check
    // `commentBridge != null` and skip / disable the action instead of
    // awaiting a Promise that never resolves.
    const commentBridge = useMemo(() => {
        if (!result.isReady) return null
        return createNativeCommentBridge({
            state: commentStateRef.current,
            postMessage: () => postMessageRef.current,
        })
    }, [result.isReady])

    // Native FindReplaceController. Reads observable state from the
    // host-side mirror store (use-find-replace-state-store.ts) that
    // dispatchFindReplaceMessage populates from the WebView's
    // state-update broadcasts; posts commands across the WebView via
    // result.postMessage. The controller's identity is pinned through
    // a ref-backed poster so it stays stable across renders.
    const findReplaceEditor = useMemo(
        () => makeNativeFindReplaceController(msg => postMessageRef.current?.(msg) ?? false),
        []
    )

    // tiptapEditor is web-only — native delegates editing to the
    // WebView's in-frame ProseMirror, which the host shell has no
    // direct dispatch handle into. commentBridge and findReplaceEditor
    // are now both available on native — they route through their
    // respective WebView namespace protocols.
    return {
        ...result,
        tiptapEditor: null,
        findReplaceEditor,
        commentBridge,
    }
}
