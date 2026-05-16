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
import { PB_SERVER_ADDR } from '@tinycld/core/lib/config'
import { useWebViewEditor } from '@tinycld/core/lib/editor/use-webview-editor'
import { pb } from '@tinycld/core/lib/pocketbase'
import { useMemo } from 'react'
import type { Awareness } from 'y-protocols/awareness'
import type * as Y from 'yjs'
import { colorForUser } from '../lib/color-for-user'
import { editorHtml } from '../webview-editor/build/editorHtml'
import type { DocumentEditorResult } from './use-document-editor'

export interface UseDocumentEditorOptions {
    yDoc: Y.Doc
    awareness: Awareness
    user?: { name: string; color: string }
    editable?: boolean
    placeholder?: string
    // Required for native: the drive_item id determines the realtime
    // room the WebView's editor connects to. On web, the parent
    // useRealtimeRoom call passes the Y.Doc directly, so this field
    // is unused. On native, we need it because the WebView opens its
    // own realtime connection (its own Y.Doc lives inside the
    // WebView's JS context). When omitted, the WebView shows
    // "Connecting…" forever — useTextDocument is responsible for
    // forwarding it.
    driveItemId?: string
}

// useDocumentEditor (native) — Phase 4. The WebView contains a full
// TipTap+Yjs editor. We hand it credentials (auth token, room id,
// user identity) via the message-bus init payload, and the WebView
// opens its own realtime room connection. The native-side Y.Doc /
// Awareness (passed via options) are NOT bound to this editor — they
// belong to the native-side useTextRoom handle, which surfaces
// serverHello / serverSlot to other native UI (save status indicator,
// readOnly flag).
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

    const initPayload = useMemo(
        () => ({
            baseURL: String(PB_SERVER_ADDR),
            roomKind: 'text-doc',
            roomId: options.driveItemId ?? '',
            token: pb.authStore.token,
            user: { id: userId, name: userName, color: userColor },
            editable: options.editable ?? true,
            placeholder: options.placeholder,
        }),
        [options.driveItemId, options.editable, options.placeholder, userId, userName, userColor]
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
    })
    // tiptapEditor + findReplaceEditor are web-only — native delegates
    // editing to the WebView's in-frame ProseMirror, which the host
    // shell has no dispatch handle into.
    return { ...result, tiptapEditor: null, findReplaceEditor: null }
}
