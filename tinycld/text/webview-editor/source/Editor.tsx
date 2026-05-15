import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import { Table } from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useState } from 'react'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { RealtimeClient } from './realtime-client'

interface InitPayload {
    baseURL: string
    roomKind: string
    roomId: string
    token: string
    user: { id: string; name: string; color: string }
    editable: boolean
    placeholder?: string
}

interface IncomingMessage {
    namespace?: string
    type?: string
    payload?: unknown
}

function postToNative(message: unknown) {
    window.ReactNativeWebView?.postMessage(JSON.stringify(message))
}

// Editor mounts in two stages:
//   1. Wait for the {namespace:'app', type:'init'} message from native
//      with credentials + room id. Until then we render a tiny
//      "Connecting…" placeholder.
//   2. Once we have the init payload, mount the EditorMounted child
//      which constructs the Y.Doc, opens the realtime connection,
//      and configures TipTap.
//
// We post {type:'editor-ready', payload:undefined} as soon as we
// mount so the native side knows we're listening. TenTap's CoreBridge
// (the only bridge we pass to useEditorBridge) treats this as the
// EditorReady signal that flips bridgeState.isReady = true. That's
// the gate useWebViewEditor waits on before posting the init payload.
export function Editor() {
    const [init, setInit] = useState<InitPayload | null>(null)

    useEffect(() => {
        function onMessage(evt: MessageEvent) {
            if (typeof evt.data !== 'string') return
            let parsed: IncomingMessage
            try {
                parsed = JSON.parse(evt.data) as IncomingMessage
            } catch {
                return
            }
            if (parsed.namespace === 'app' && parsed.type === 'init') {
                setInit(parsed.payload as InitPayload)
            }
        }
        window.addEventListener('message', onMessage)
        document.addEventListener('message', onMessage as EventListener)
        postToNative({ type: 'editor-ready', payload: undefined })
        return () => {
            window.removeEventListener('message', onMessage)
            document.removeEventListener('message', onMessage as EventListener)
        }
    }, [])

    if (init == null) {
        return <div style={{ padding: 24, color: '#999' }}>Connecting…</div>
    }

    return <EditorMounted init={init} />
}

interface EditorMountedProps {
    init: InitPayload
}

function EditorMounted({ init }: EditorMountedProps) {
    // Construct Y.Doc + Awareness exactly once per mount. The parent
    // <Editor /> only renders <EditorMounted /> after the init payload
    // arrives, so this is effectively a one-shot construction tied to
    // the init payload's identity.
    const [{ yDoc, awareness }] = useState(() => {
        const doc = new Y.Doc()
        const aw = new Awareness(doc)
        aw.setLocalStateField('user', init.user)
        return { yDoc: doc, awareness: aw }
    })

    useEffect(() => {
        const wsProto = init.baseURL.startsWith('https') ? 'wss' : 'ws'
        const wsBase = init.baseURL.replace(/^https?/, wsProto)
        const url =
            `${wsBase}/api/realtime/${encodeURIComponent(init.roomKind)}/` +
            `${encodeURIComponent(init.roomId)}?token=${encodeURIComponent(init.token)}`
        const client = new RealtimeClient({
            url,
            doc: yDoc,
            awareness,
        })
        client.connect()
        return () => client.destroy()
    }, [yDoc, awareness, init.baseURL, init.roomKind, init.roomId, init.token])

    const editor = useEditor({
        editable: init.editable,
        extensions: [
            StarterKit.configure({
                undoRedo: false,
                link: { openOnClick: false },
            }),
            Placeholder.configure({
                placeholder: init.placeholder ?? 'Start writing…',
            }),
            Table.configure({ resizable: false }),
            TableRow,
            TableHeader,
            TableCell,
            Image,
            Collaboration.configure({ document: yDoc, field: 'prosemirror' }),
            CollaborationCaret.configure({
                provider: { awareness },
                user: init.user,
            }),
        ],
    })

    // Stream toolbar state out to native on every transaction. TenTap's
    // CoreEditorActionType.StateUpdate is the channel useBridgeState
    // consumes — we mirror its shape so the native side's useBridgeState
    // picks up our state. The exact wire type string is 'stateUpdate'
    // (from CoreEditorActionType.StateUpdate).
    //
    // Coalesced with requestAnimationFrame so a burst of transactions
    // (bulk paste, initial Y.Doc sync, undo of a large change) at most
    // produces one stateUpdate per frame. A serialized-payload identity
    // skip further suppresses sends when the toolbar state is unchanged
    // (e.g. remote-only edits that don't move the local selection).
    useEffect(() => {
        if (!editor) return
        let scheduled = false
        let lastSerialized = ''
        function sendState() {
            if (!editor) return
            const payload = {
                isReady: true,
                editable: editor.isEditable,
                isFocused: editor.isFocused,
                empty: editor.isEmpty,
                selection: {
                    from: editor.state.selection.from,
                    to: editor.state.selection.to,
                },
                isBoldActive: editor.isActive('bold'),
                isItalicActive: editor.isActive('italic'),
                isUnderlineActive: editor.isActive('underline'),
                isBulletListActive: editor.isActive('bulletList'),
                isOrderedListActive: editor.isActive('orderedList'),
                isBlockquoteActive: editor.isActive('blockquote'),
                isLinkActive: editor.isActive('link'),
                activeLink: (editor.getAttributes('link')?.href as string) ?? null,
            }
            const serialized = JSON.stringify({ type: 'stateUpdate', payload })
            if (serialized === lastSerialized) return
            lastSerialized = serialized
            window.ReactNativeWebView?.postMessage(serialized)
        }
        function schedule() {
            if (scheduled) return
            scheduled = true
            requestAnimationFrame(() => {
                scheduled = false
                sendState()
            })
        }
        schedule()
        editor.on('transaction', schedule)
        editor.on('focus', schedule)
        editor.on('blur', schedule)
        return () => {
            editor.off('transaction', schedule)
            editor.off('focus', schedule)
            editor.off('blur', schedule)
        }
    }, [editor])

    // Listen for command messages from native. TenTap's per-bridge
    // format commands flow as { type: 'toggle-bold', payload: ... }
    // without an explicit namespace. Our own command messages use
    // namespace 'format'. Accept both shapes so we can toggle bold/
    // italic/etc. from either path.
    useEffect(() => {
        if (!editor) return
        function onMessage(evt: MessageEvent) {
            if (typeof evt.data !== 'string') return
            let parsed: IncomingMessage
            try {
                parsed = JSON.parse(evt.data) as IncomingMessage
            } catch {
                return
            }
            // Init messages handled by parent <Editor />.
            if (parsed.namespace === 'app') return
            const t = parsed.type
            if (!t) return
            switch (t) {
                case 'toggle-bold':
                    editor.chain().focus().toggleBold().run()
                    break
                case 'toggle-italic':
                    editor.chain().focus().toggleItalic().run()
                    break
                case 'toggle-underline':
                    editor.chain().focus().toggleUnderline().run()
                    break
                // TenTap's BulletListBridge and OrderedListBridge emit
                // camelCase action strings ('toggle-bulletList' /
                // 'toggle-orderedList'), not kebab-case. We must match
                // the exact emitted literal or the message is dropped.
                case 'toggle-bulletList':
                    editor.chain().focus().toggleBulletList().run()
                    break
                case 'toggle-orderedList':
                    editor.chain().focus().toggleOrderedList().run()
                    break
                case 'toggle-blockquote':
                    editor.chain().focus().toggleBlockquote().run()
                    break
                case 'toggle-heading': {
                    // TenTap's HeadingBridge sends the level number
                    // directly as payload, not wrapped in { level }.
                    const level = (parsed.payload as number | undefined) ?? 1
                    editor
                        .chain()
                        .focus()
                        .toggleHeading({ level: level as 1 | 2 | 3 })
                        .run()
                    break
                }
                case 'set-link': {
                    // TenTap's LinkBridge sends { type:'set-link', payload: <string|null> }
                    const url = parsed.payload as string | null
                    if (url == null) break
                    if (url === '') {
                        editor.chain().focus().extendMarkRange('link').unsetLink().run()
                    } else {
                        editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
                    }
                    break
                }
                case 'remove-link':
                    editor.chain().focus().unsetLink().run()
                    break
                case 'undo':
                    editor.chain().focus().undo().run()
                    break
                case 'redo':
                    editor.chain().focus().redo().run()
                    break
                case 'set-editable': {
                    const next = parsed.payload as boolean
                    editor.setEditable(next)
                    break
                }
                case 'insert-table': {
                    const { rows, cols } = parsed.payload as { rows: number; cols: number }
                    editor
                        .chain()
                        .focus()
                        .insertTable({ rows, cols, withHeaderRow: true })
                        .run()
                    break
                }
                case 'add-row-before':
                    editor.chain().focus().addRowBefore().run()
                    break
                case 'add-row-after':
                    editor.chain().focus().addRowAfter().run()
                    break
                case 'add-column-before':
                    editor.chain().focus().addColumnBefore().run()
                    break
                case 'add-column-after':
                    editor.chain().focus().addColumnAfter().run()
                    break
                case 'delete-row':
                    editor.chain().focus().deleteRow().run()
                    break
                case 'delete-column':
                    editor.chain().focus().deleteColumn().run()
                    break
                case 'delete-table':
                    editor.chain().focus().deleteTable().run()
                    break
                case 'insert-image': {
                    const { src, alt } = parsed.payload as { src: string; alt?: string }
                    editor.chain().focus().setImage({ src, alt }).run()
                    break
                }
            }
        }
        window.addEventListener('message', onMessage)
        document.addEventListener('message', onMessage as EventListener)
        return () => {
            window.removeEventListener('message', onMessage)
            document.removeEventListener('message', onMessage as EventListener)
        }
    }, [editor])

    return <EditorContent editor={editor} />
}
