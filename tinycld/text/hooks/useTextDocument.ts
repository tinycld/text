import { useDocumentEditor } from '@tinycld/core/lib/editor/use-document-editor'
import type { RealtimeRoomHandle } from '@tinycld/core/lib/realtime/use-realtime-room'
import { typedServerHello, typedServerSlot } from './useTextRoom'

// useTextDocument wires the realtime room's Y.Doc + Awareness into the
// shared document editor and surfaces the text-specific server slot
// state (saveStatus) alongside the editor result.
//
// Note on user identity: the local user's name + color land in
// awareness.user via useTextRoom's initialAwareness. We deliberately
// don't pass `user` to useDocumentEditor — the CollaborationCaret
// extension's `user` option writes into awareness.user on mount and
// would clobber the slot we just set.
export function useTextDocument(room: RealtimeRoomHandle) {
    const hello = typedServerHello(room)
    const slot = typedServerSlot(room)
    const editorResult = useDocumentEditor({
        yDoc: room.doc,
        awareness: room.awareness,
        editable: !hello.readOnly,
    })
    return {
        ...editorResult,
        saveStatus: slot.saveStatus,
    }
}
