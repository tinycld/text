import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { Color } from '@tiptap/extension-color'
import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import { Table } from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TextAlign from '@tiptap/extension-text-align'
import { TextStyle } from '@tiptap/extension-text-style'
import { FontFamily } from '@tiptap/extension-text-style/font-family'
import { FontSize } from '@tiptap/extension-text-style/font-size'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { applyCellBorders } from '../../lib/apply-cell-borders'
import { applyCellShading } from '../../lib/apply-cell-shading'
import { BorderedTableCell, BorderedTableHeader } from '../../lib/bordered-table-cells'
import type { CellBorder, CellBorderPreset } from '../../lib/cell-borders'
import { BlockIndent, MAX_INDENT_LEVEL } from '../../lib/editor/block-indent'
import {
    CodeShortcuts,
    deriveActiveHeadingLevel,
    deriveActiveIndent,
    deriveCurrentAlign,
    deriveCurrentFontFamily,
    deriveCurrentFontSize,
    deriveImageSelection,
} from './editor-state'

// Inline image variant carrying a `wrap` attr (left|right|none) on
// the rendered <img> as data-wrap, so editor-content-styles can
// apply float:left / float:right. Matches the shape produced by the
// .docx importer in translate/docx_to_pm.go. See the longer notes in
// the web editor's WrappedImage definition.
const WrappedImage = Image.extend({
    inline: true,
    group: 'inline',
    addAttributes() {
        return {
            ...this.parent?.(),
            wrap: {
                default: null,
                // Whitelist legal values; mirror the web editor's
                // schema exactly. See lib/image-wrap-modes.ts for the
                // single source of truth on the legal value set.
                parseHTML: (el: HTMLElement) => {
                    const raw = el.getAttribute('data-wrap')
                    if (raw === 'left' || raw === 'right' || raw === 'break') return raw
                    return null
                },
                renderHTML: (attrs: { wrap?: string | null }) => {
                    if (!attrs.wrap) return {}
                    return { 'data-wrap': attrs.wrap }
                },
            },
        }
    },
})
import { useEffect, useState } from 'react'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { CommentMark } from '../../lib/editor/comment-mark'
import { SlashMenu } from '../../lib/editor/slash-menu'
import { installCommentBridge } from './bridges/comment-bridge'
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
            // See use-document-editor.web.tsx for the rationale — both
            // editor mounts must share the same schema so a doc seeded
            // by one is readable by the other. TextStyle/Color/FontSize/
            // FontFamily share a single textStyle mark on the schema;
            // TextAlign and BlockIndent contribute attrs on paragraph +
            // heading. Without these extensions the WebView's schema
            // diverges from the web schema and attrs written by a web
            // peer would be silently dropped on a native edit.
            TextStyle,
            Color,
            FontSize,
            FontFamily,
            TextAlign.configure({
                types: ['paragraph', 'heading'],
                alignments: ['left', 'center', 'right', 'justify'],
                defaultAlignment: null,
            }),
            BlockIndent.configure({ types: ['paragraph', 'heading'] }),
            Placeholder.configure({
                placeholder: init.placeholder ?? 'Start writing…',
            }),
            Table.configure({ resizable: true, handleWidth: 5, cellMinWidth: 32 }),
            TableRow,
            BorderedTableHeader,
            BorderedTableCell,
            WrappedImage,
            CommentMark,
            CodeShortcuts,
            // SlashMenu — the `bridge` strategy posts ui.show-popover /
            // popover-update / popover-dismissed messages out of the
            // WebView so the host's AnchoredOverlayController renders
            // the popover as a Modal positioned over the WebView. The
            // host-side `openImageInsert` action isn't reachable from
            // inside the WebView (the file picker lives at the screen
            // level on native), so we don't wire that option through —
            // the slash-menu Image entry deletes the trigger and
            // inserts nothing on native, matching the web variant's
            // behavior when openImageInsert isn't supplied.
            SlashMenu.configure({ renderStrategy: 'bridge' }),
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
        // Shadow string for the ui.selection-changed channel. Kept
        // separate from lastSerialized so a typing burst inside text
        // (which churns stateUpdate every frame) doesn't re-broadcast
        // a stable "no image selected" payload on every transaction.
        let lastImageSerialized = ''
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
                isInTable: editor.isActive('table'),
                selectionEmpty: editor.state.selection.empty,
                canMergeCells: editor.can().mergeCells(),
                canSplitCell: editor.can().splitCell(),
                isCodeActive: editor.isActive('code'),
                isCodeBlockActive: editor.isActive('codeBlock'),
                activeHeadingLevel: deriveActiveHeadingLevel(editor),
                currentAlign: deriveCurrentAlign(editor),
                canIndent: deriveActiveIndent(editor) < MAX_INDENT_LEVEL,
                canOutdent: deriveActiveIndent(editor) > 0,
                currentFontSize: deriveCurrentFontSize(editor),
                currentFontFamily: deriveCurrentFontFamily(editor),
            }
            const serialized = JSON.stringify({ type: 'stateUpdate', payload })
            if (serialized !== lastSerialized) {
                lastSerialized = serialized
                window.ReactNativeWebView?.postMessage(serialized)
            }

            // Broadcast image selection on the 'ui' namespace. The
            // host's native-side bottom sheet subscribes to this and
            // opens whenever payload.kind === 'image'. Kept outside the
            // stateUpdate payload so image-related UI concerns don't
            // contaminate the toolbar's bridge state shape.
            const imageSel = deriveImageSelection(editor, editor.view)
            const imageMsg = JSON.stringify({
                namespace: 'ui',
                type: 'selection-changed',
                payload: imageSel
                    ? { kind: 'image', image: imageSel }
                    : { kind: 'none' },
            })
            if (imageMsg !== lastImageSerialized) {
                lastImageSerialized = imageMsg
                window.ReactNativeWebView?.postMessage(imageMsg)
            }
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
            // Init messages handled by parent <Editor />. Comment-bus
            // messages have their own listener installed by
            // installCommentBridge below.
            if (parsed.namespace === 'app') return
            if (parsed.namespace === 'comment') return
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
                case 'merge-cells':
                    editor.chain().focus().mergeCells().run()
                    break
                case 'split-cell':
                    editor.chain().focus().splitCell().run()
                    break
                case 'merge-or-split':
                    editor.chain().focus().mergeOrSplit().run()
                    break
                case 'set-cell-borders': {
                    const payload = parsed.payload as {
                        preset: CellBorderPreset
                        border?: Partial<CellBorder>
                    }
                    editor.commands.focus()
                    applyCellBorders(editor, { preset: payload.preset, border: payload.border })
                    break
                }
                case 'set-cell-shading': {
                    const payload = parsed.payload as { color: string | null }
                    editor.commands.focus()
                    applyCellShading(editor, payload.color)
                    break
                }
                case 'toggle-code':
                    editor.chain().focus().toggleCode().run()
                    break
                case 'toggle-code-block':
                    editor.chain().focus().toggleCodeBlock().run()
                    break
                case 'set-text-align': {
                    const align = parsed.payload
                    if (
                        align === 'left' ||
                        align === 'center' ||
                        align === 'right' ||
                        align === 'justify'
                    ) {
                        editor.chain().focus().setTextAlign(align).run()
                    }
                    break
                }
                case 'unset-text-align':
                    editor.chain().focus().unsetTextAlign().run()
                    break
                case 'indent-block':
                    editor.chain().focus().indentBlock().run()
                    break
                case 'outdent-block':
                    editor.chain().focus().outdentBlock().run()
                    break
                case 'set-font-size': {
                    const px = parsed.payload
                    if (typeof px === 'number' && Number.isFinite(px) && px > 0) {
                        editor.chain().focus().setFontSize(`${px}px`).run()
                    }
                    break
                }
                case 'unset-font-size':
                    editor.chain().focus().unsetFontSize().run()
                    break
                case 'set-font-family': {
                    const family = parsed.payload
                    if (typeof family === 'string' && family !== '') {
                        editor.chain().focus().setFontFamily(family).run()
                    }
                    break
                }
                case 'unset-font-family':
                    editor.chain().focus().unsetFontFamily().run()
                    break
                case 'insert-image': {
                    const { src, alt } = parsed.payload as { src: string; alt?: string }
                    editor.chain().focus().setImage({ src, alt }).run()
                    break
                }
                case 'update-image-attrs': {
                    const payload = parsed.payload
                    if (payload === null || typeof payload !== 'object') break
                    const next: Record<string, unknown> = {}
                    const wrap = (payload as { wrap?: unknown }).wrap
                    if (
                        wrap === 'left' ||
                        wrap === 'right' ||
                        wrap === 'break' ||
                        wrap === null
                    ) {
                        next.wrap = wrap
                    }
                    const width = (payload as { width?: unknown }).width
                    if (typeof width === 'number' && Number.isFinite(width) && width > 0) {
                        next.width = Math.round(width)
                    }
                    const height = (payload as { height?: unknown }).height
                    if (typeof height === 'number' && Number.isFinite(height) && height > 0) {
                        next.height = Math.round(height)
                    }
                    if (Object.keys(next).length === 0) break
                    editor.chain().focus().updateAttributes('image', next).run()
                    break
                }
                case 'cut':
                    editor.commands.focus()
                    document.execCommand('cut')
                    break
                case 'copy':
                    editor.commands.focus()
                    document.execCommand('copy')
                    break
                case 'paste':
                    // execCommand('paste') is blocked in WebView contexts
                    // unless the host grants special permission. Fall
                    // back to the async clipboard API and insert via
                    // Tiptap so the change rides through one collab tx.
                    editor.commands.focus()
                    navigator.clipboard
                        ?.readText()
                        .then(text => {
                            if (!text) return
                            editor.chain().focus().insertContent(text).run()
                        })
                        .catch(() => undefined)
                    break
                case 'delete-selection':
                    editor.chain().focus().deleteSelection().run()
                    break
                case 'select-all':
                    editor.chain().focus().selectAll().run()
                    break
            }
        }
        window.addEventListener('message', onMessage)
        document.addEventListener('message', onMessage as EventListener)
        return () => {
            window.removeEventListener('message', onMessage)
            document.removeEventListener('message', onMessage as EventListener)
        }
    }, [editor])

    useEffect(() => {
        if (!editor) return
        const bridge = installCommentBridge(editor, postToNative)
        return () => bridge.destroy()
    }, [editor])

    // Forward in-document scroll events out to the host. The host's
    // useWebViewEditor receives this on its 'ui' namespace channel and
    // fires its onScroll callback, which the native variant uses to
    // dismiss any open anchored popover (slash menu, future popovers).
    //
    // iOS RN-WebView's own `onScroll` doesn't fire for in-document
    // scrolling when scrollEnabled=false (which TenTap sets), so the
    // signal has to come from the WebView's document. Coalesced via
    // rAF so a smooth scroll doesn't flood the message bus.
    useEffect(() => {
        let scheduled = false
        function onScroll() {
            if (scheduled) return
            scheduled = true
            requestAnimationFrame(() => {
                scheduled = false
                postToNative({
                    namespace: 'ui',
                    type: 'document-scroll',
                    payload: null,
                })
            })
        }
        window.addEventListener('scroll', onScroll, { passive: true })
        // Some Tiptap scroll containers nest the scrolling viewport
        // inside .ProseMirror rather than at window level. Capture
        // scroll events from any element so the dismiss policy fires
        // regardless of which container actually scrolls.
        document.addEventListener('scroll', onScroll, { passive: true, capture: true })
        return () => {
            window.removeEventListener('scroll', onScroll)
            document.removeEventListener('scroll', onScroll, true)
        }
    }, [])

    return <EditorContent editor={editor} />
}
