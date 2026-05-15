import { CoreBridge } from '@10play/tentap-editor'
import { useAuth } from '@tinycld/core/lib/auth'
import { PB_SERVER_ADDR } from '@tinycld/core/lib/config'
import type { EditorResult } from '@tinycld/core/lib/editor/types'
import { useWebViewEditor } from '@tinycld/core/lib/editor/use-webview-editor'
import { pb } from '@tinycld/core/lib/pocketbase'
import { useMemo } from 'react'
import type { Awareness } from 'y-protocols/awareness'
import type * as Y from 'yjs'
import { colorForUser } from '../lib/color-for-user'
import { editorHtml } from '../webview-editor/build/editorHtml'

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
// CoreBridge is the only TenTap bridge we pass to useWebViewEditor.
// It's the one responsible for translating the incoming 'stateUpdate'
// messages into BridgeState updates that useBridgeState observes.
// The other TenTap bridges (BoldBridge, etc.) are unnecessary here
// because we use customSource — our in-WebView React app owns its
// own TipTap configuration, and the bridges' tiptapExtension wiring
// is only relevant to TenTap's default editor HTML.
export function useDocumentEditor(options: UseDocumentEditorOptions): EditorResult {
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

    return useWebViewEditor({
        editorHtml,
        bridgeExtensions: [CoreBridge],
        initPayload,
        editable: options.editable ?? true,
    })
}
