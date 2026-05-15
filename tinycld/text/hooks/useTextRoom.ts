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
