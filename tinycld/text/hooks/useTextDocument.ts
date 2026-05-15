import type { RealtimeRoomHandle } from '@tinycld/core/lib/realtime/use-realtime-room'
import { useDocumentEditor } from './use-document-editor'
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
//
// driveItemId is forwarded to the native editor variant, which uses
// it to open its own realtime connection inside the WebView (the
// native-side `room` is for serverHello/serverSlot only — its Y.Doc
// is not bound to the WebView editor). The web variant ignores it.
export function useTextDocument(room: RealtimeRoomHandle, driveItemId: string) {
    const hello = typedServerHello(room)
    const slot = typedServerSlot(room)
    const editorResult = useDocumentEditor({
        yDoc: room.doc,
        awareness: room.awareness,
        editable: !hello.readOnly,
        driveItemId,
    })
    return {
        ...editorResult,
        saveStatus: slot.saveStatus,
    }
}
