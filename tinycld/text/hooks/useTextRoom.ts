import { useAuth } from '@tinycld/core/lib/auth'
import {
    type RealtimeRoomHandle,
    useRealtimeRoom,
} from '@tinycld/core/lib/realtime/use-realtime-room'
import { colorForUser } from '../lib/color-for-user'

export interface TextServerHello {
    readOnly: boolean
    importWarnings: { code: string; detail?: string }[]
}

export interface TextServerSlot {
    saveStatus: 'ok' | 'failed'
}

// useTextRoom is the text-specific wrapper around core's useRealtimeRoom.
// It supplies the 'text-doc' roomKind and stamps the local awareness
// slot with the current user's identity so collaboration cursors render
// with a name + deterministic color.
//
// The server (text/server) populates the room's Y.Doc from the source
// .docx before the first SyncReply goes out, so the client never needs
// to fetch or parse docx bytes.
//
// On native, the in-WebView editor opens its own realtime room
// connection inside the WebView's JS context (see
// use-document-editor.native.tsx for the architecture). This native-
// side room is kept open purely for:
//   - hello.readOnly: the share-role gate that disables the editor
//   - hello.importWarnings: surfaced via ImportWarningBanner
//   - slot.saveStatus: surfaced via the save-status indicator
// The native room's Y.Doc is NOT bound to the WebView editor; the
// WebView holds the canonical editing Y.Doc.
//
// TODO(text-native v1.1): on native, the in-WebView editor opens a
// SEPARATE realtime connection with its OWN awareness identity. That
// means the local user appears as TWO collaborators to remote peers
// (one native client, one WebView client). To dedupe, either:
//   1. Suppress this native room's awareness slot (don't pass
//      initialAwareness) and route presence through a message-bus
//      relay from the WebView to PresenceAvatars.
//   2. Tag awareness records with a clientGroupId and dedupe in
//      PresenceAvatars.
// Option 1 is cleaner but requires touching the PresenceAvatars
// consumer. Picking the right approach depends on what other native
// callers need from the native-side room's awareness.
export function useTextRoom(driveItemId: string): RealtimeRoomHandle | null {
    const { user } = useAuth()
    const userId = user?.id ?? ''
    const userName = user?.name ?? ''

    return useRealtimeRoom({
        roomKind: 'text-doc',
        roomID: driveItemId,
        initialAwareness: userId
            ? {
                  user: { id: userId, name: userName, color: colorForUser(userId) },
                  cursor: null,
              }
            : null,
    })
}

// typedServerHello narrows the realtime room's opaque serverHello payload
// to the text-specific shape, with safe defaults when the hello hasn't
// arrived yet (e.g. during the open handshake) or the room handle is
// still null.
export function typedServerHello(room: RealtimeRoomHandle | null): TextServerHello {
    if (room == null || room.serverHello == null) {
        return { readOnly: false, importWarnings: [] }
    }
    return room.serverHello as TextServerHello
}

// typedServerSlot narrows the realtime room's opaque serverSlot payload
// to the text-specific shape. Defaults to 'ok' so the SaveStatus
// indicator doesn't flash 'failed' before the first slot frame arrives.
export function typedServerSlot(room: RealtimeRoomHandle | null): TextServerSlot {
    if (room == null || room.serverSlot == null) {
        return { saveStatus: 'ok' }
    }
    return room.serverSlot as TextServerSlot
}
