import { Extension } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { Color } from '@tiptap/extension-color'
import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import { Table } from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TextAlign from '@tiptap/extension-text-align'
import { TextStyle } from '@tiptap/extension-text-style'
import { BackgroundColor } from '@tiptap/extension-text-style/background-color'
import { FontFamily } from '@tiptap/extension-text-style/font-family'
import { FontSize } from '@tiptap/extension-text-style/font-size'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useState } from 'react'
import { Awareness, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { BorderedTableCell, BorderedTableHeader } from '../../lib/bordered-table-cells'
import { BlockIndent, MAX_INDENT_LEVEL } from '../../lib/editor/block-indent'
import { CommentMark } from '../../lib/editor/comment-mark'
import { DropCap } from '../../lib/editor/drop-cap'
import { SlashMenu } from '../../lib/editor/slash-menu'
import { findReplacePlugin } from '../../lib/find-replace-plugin'
import { buildSuggestionEditorExtensions } from '../../lib/suggestions/build-extensions'
import { countWords } from '../../lib/word-count'
import type { EditorModeStore } from '../../stores/editor-mode-store'
import { installCommentBridge } from './bridges/comment-bridge'
import { installFindReplaceBridge } from './bridges/find-replace-bridge'
import { installFormatBridge } from './bridges/format-bridge'
import {
    CodeShortcuts,
    deriveActiveHeadingLevel,
    deriveActiveIndent,
    deriveCurrentAlign,
    deriveCurrentBackgroundColor,
    deriveCurrentFontFamily,
    deriveCurrentFontSize,
    deriveCurrentTextColor,
    deriveImageSelection,
} from './editor-state'
import {
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
} from './relay-protocol'
import { installSuggestionListBridge } from './suggestions/list-bridge'

// Local extensions declared in this module — kept together so the
// import block stays uninterrupted and the in-line `Extension.create`
// definitions don't sit in the middle of unrelated runtime code.

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

// FindReplaceExtension wraps the find/replace plugin in a Tiptap
// Extension wrapper so it can sit alongside the other extensions
// declared in useEditor(). The plugin itself lives in
// lib/find-replace-plugin.ts and is shared with the web editor mount.
// The native FindReplaceBar drives it through the host -> WebView
// 'find-replace' namespace bridge (see bridges/find-replace-bridge.ts).
const FindReplaceExtension = Extension.create({
    name: 'tinycldFindReplace',
    addProseMirrorPlugins() {
        return [findReplacePlugin()]
    },
})

// Mirrors the runtime augmentation in entry.tsx. Declared here too so
// this module typechecks standalone (e.g. via the editor-schema tests,
// which import Editor.tsx without pulling in entry.tsx). Both
// declarations describe the same Window field; TypeScript merges them.
declare global {
    interface Window {
        ReactNativeWebView?: { postMessage: (s: string) => void }
    }
}

/**
 * Everything the page needs to build its editor.
 *
 * Note what is NOT here any more: `baseURL`, `roomKind`, `roomId` and `token`.
 * The page used to open its own WebSocket with those, which meant shipping a
 * live credential into a WebView and — because that connection carried its own
 * awareness identity — making one human appear as two peers, with two avatars
 * and two carets and a slot the host's presence teardown could never clean up.
 *
 * The host owns the one connection now and relays over the bridge instead, the
 * arrangement `@tinycld/core/lib/editor/rich` was built for.
 */
interface InitPayload {
    user: { id: string; name: string; color: string }
    editable: boolean
    placeholder?: string
    /**
     * The drive_item id. Correlation only — it names the document the
     * suggestion-list bridge is reporting on, and no longer selects a
     * connection for this page to open.
     */
    documentId: string
    /** Base64 `Y.encodeStateAsUpdate` of the host doc at init. */
    initialState?: string
    /** Base64 `encodeAwarenessUpdate` of the peers already in the room. */
    peers?: string
}

interface BuildEditorExtensionsOptions {
    placeholder?: string
    yDoc?: Y.Doc
    awareness?: Awareness
    user?: { id: string; name: string; color: string }
    modeStore?: EditorModeStore
}

// buildEditorExtensions returns the full TipTap extension list used by
// the WebView editor. Lives at module scope so tests can introspect the
// resulting schema (see tests/suggestions/editor-schema.test.ts) without
// mounting the editor. The Y.Doc / Awareness / user dependencies are
// optional so schema-only callers (tests, type checks) can build the
// list without paying the cost of constructing a realtime client.
export function buildEditorExtensions(options: BuildEditorExtensionsOptions = {}) {
    return [
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
        BackgroundColor,
        FontSize,
        FontFamily,
        TextAlign.configure({
            types: ['paragraph', 'heading'],
            alignments: ['left', 'center', 'right', 'justify'],
            defaultAlignment: null,
        }),
        BlockIndent.configure({ types: ['paragraph', 'heading'] }),
        // DropCap must be in the shared schema (see the TextStyle
        // comment above) so a dropCap attr written by a web peer
        // survives a native edit. Paragraph only.
        DropCap.configure({ types: ['paragraph'] }),
        Placeholder.configure({
            placeholder: options.placeholder ?? 'Start writing…',
        }),
        Table.configure({ resizable: true, handleWidth: 5, cellMinWidth: 32 }),
        TableRow,
        BorderedTableHeader,
        BorderedTableCell,
        WrappedImage,
        CommentMark,
        CodeShortcuts,
        FindReplaceExtension,
        // SlashMenu — the `bridge` strategy posts ui.show-popover /
        // popover-update / popover-exited messages out of the
        // WebView so the host's AnchoredOverlayController renders
        // the popover as a Modal positioned over the WebView. The
        // host-side `openImageInsert` action isn't reachable from
        // inside the WebView (the file picker lives at the screen
        // level on native), so we don't wire that option through —
        // the slash-menu Image entry deletes the trigger and
        // inserts nothing on native, matching the web variant's
        // behavior when openImageInsert isn't supplied.
        SlashMenu.configure({ renderStrategy: 'bridge' }),
        Collaboration.configure({ document: options.yDoc, field: 'prosemirror' }),
        CollaborationCaret.configure({
            provider: { awareness: options.awareness },
            user: options.user,
        }),
        ...buildSuggestionEditorExtensions(
            options.modeStore && options.yDoc
                ? { modeStore: options.modeStore, yDoc: options.yDoc }
                : undefined
        ),
    ]
}

interface IncomingMessage {
    namespace?: string
    type?: string
    payload?: unknown
}

function postToNative(message: unknown) {
    window.ReactNativeWebView?.postMessage(JSON.stringify(message))
}

/** Tags doc transactions the host sent us, so the relay doesn't post them
 *  straight back and bounce a single keystroke between the two docs forever. */
const FROM_HOST: unique symbol = Symbol('yjs:from-host')

/** The same guard for awareness. */
const FROM_HOST_AWARENESS: unique symbol = Symbol('awareness:from-host')

/**
 * Read a bridge message, or null if it isn't one.
 *
 * Both listeners below need this, and both `window` and `document` need the
 * listener — the two platforms differ in which one delivers.
 */
function parseBridgeMessage(evt: MessageEvent | Event): EditorMessage | null {
    const data = (evt as MessageEvent).data
    if (typeof data !== 'string') return null
    try {
        return JSON.parse(data) as EditorMessage
    } catch {
        return null
    }
}

/**
 * Pump document updates between this page's Y.Doc and the host.
 *
 * The page opens no connection of its own: the host already holds the room
 * socket, and a second one would ship a credential in here and make the local
 * user two peers. Outbound is guarded on FROM_HOST so an update we just applied
 * isn't posted back; the host guards the mirror-image case with its own origin.
 */
function useYjsRelay(doc: Y.Doc) {
    useEffect(() => {
        function onLocalUpdate(update: Uint8Array, origin: unknown) {
            if (origin === FROM_HOST) return
            postToNative(makeMessage('yjs', YJS_UPDATE, { update: encodeUpdate(update) }))
        }
        doc.on('update', onLocalUpdate)

        function onMessage(evt: MessageEvent | Event) {
            const parsed = parseBridgeMessage(evt)
            if (!parsed || parsed.namespace !== 'yjs' || parsed.type !== YJS_UPDATE) return
            const encoded = (parsed.payload as YjsUpdatePayload | undefined)?.update
            if (typeof encoded !== 'string' || encoded.length === 0) return
            try {
                Y.applyUpdate(doc, decodeUpdate(encoded), FROM_HOST)
            } catch {
                // Convergent by construction: the next update from that peer
                // carries the same state and repairs the gap.
            }
        }
        window.addEventListener('message', onMessage)
        document.addEventListener('message', onMessage)
        return () => {
            doc.off('update', onLocalUpdate)
            window.removeEventListener('message', onMessage)
            document.removeEventListener('message', onMessage)
        }
    }, [doc])
}

/**
 * Pump collaborator carets between this page's Awareness and the host.
 *
 * Asymmetric on purpose: outbound carries only this page's own CURSOR POSITION,
 * never an encoded awareness state, because the host merges it into its own slot
 * — that is what keeps one human to one avatar now that the page has no identity
 * on the wire. Inbound applies whatever the host relays, already filtered down
 * to remote peers.
 */
function useAwarenessRelay(awareness: Awareness) {
    useEffect(() => {
        let lastSent: string | null = null
        function onLocalAwareness(
            { added, updated }: { added: number[]; updated: number[] },
            origin: unknown
        ) {
            if (origin === FROM_HOST_AWARENESS) return
            if (![...added, ...updated].includes(awareness.clientID)) return
            const cursor =
                (awareness.getLocalState() as { cursor?: unknown } | null)?.cursor ?? null
            // y-tiptap rewrites the cursor field on every transaction; without
            // this skip a burst of typing posts an identical cursor dozens of
            // times.
            const serialized = JSON.stringify(cursor ?? null)
            if (serialized === lastSent) return
            lastSent = serialized
            postToNative(makeMessage('awareness', AWARENESS_CURSOR, { cursor }))
        }
        awareness.on('update', onLocalAwareness)

        function onMessage(evt: MessageEvent | Event) {
            const parsed = parseBridgeMessage(evt)
            if (!parsed || parsed.namespace !== 'awareness') return
            try {
                if (parsed.type === AWARENESS_PEERS) {
                    const encoded = (parsed.payload as AwarenessPeersPayload | undefined)?.update
                    if (typeof encoded !== 'string' || encoded.length === 0) return
                    applyAwarenessUpdate(awareness, decodeUpdate(encoded), FROM_HOST_AWARENESS)
                } else if (parsed.type === AWARENESS_LEAVE) {
                    const ids = (parsed.payload as AwarenessLeavePayload | undefined)?.clientIDs
                    if (!Array.isArray(ids) || ids.length === 0) return
                    removeAwarenessStates(awareness, ids, FROM_HOST_AWARENESS)
                }
            } catch {
                // A malformed frame costs one repaint of the carets.
            }
        }
        window.addEventListener('message', onMessage)
        document.addEventListener('message', onMessage)
        return () => {
            awareness.off('update', onLocalAwareness)
            window.removeEventListener('message', onMessage)
            document.removeEventListener('message', onMessage)
        }
    }, [awareness])
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
    //
    // Both are seeded from the host rather than filled by a connection of this
    // page's own. Seeding the doc with a Yjs UPDATE (not text) is what makes it
    // the same document as the host's rather than a copy that happens to start
    // alike.
    const [{ yDoc, awareness }] = useState(() => {
        const doc = new Y.Doc()
        if (init.initialState) {
            Y.applyUpdate(doc, decodeUpdate(init.initialState), FROM_HOST)
        }
        const aw = new Awareness(doc)
        aw.setLocalStateField('user', init.user)
        if (init.peers) {
            try {
                applyAwarenessUpdate(aw, decodeUpdate(init.peers), FROM_HOST_AWARENESS)
            } catch {
                // A bad seed costs the initial carets, not the editor.
            }
        }
        return { yDoc: doc, awareness: aw }
    })

    useYjsRelay(yDoc)
    useAwarenessRelay(awareness)

    const editor = useEditor({
        editable: init.editable,
        extensions: buildEditorExtensions({
            placeholder: init.placeholder,
            yDoc,
            awareness,
            user: init.user,
        }),
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
                isDropCapActive: editor.isActive('paragraph', { dropCap: true }),
                currentFontSize: deriveCurrentFontSize(editor),
                currentFontFamily: deriveCurrentFontFamily(editor),
                currentTextColor: deriveCurrentTextColor(editor),
                currentBackgroundColor: deriveCurrentBackgroundColor(editor),
                // Broadcast the live word count alongside every other
                // toolbar state field. The rAF-coalesce + identity-skip
                // already throttle this; doc.textContent is O(N) over
                // doc text which matches the web variant's per-update
                // cost. Native consumer surfaces this as
                // toolbarState.wordCount via useWebViewEditor's loose-
                // state read.
                wordCount: countWords(editor.state.doc.textContent),
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
                payload: imageSel ? { kind: 'image', image: imageSel } : { kind: 'none' },
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

    // Format command messages: TenTap's per-bridge commands (toggle-bold,
    // toggle-heading, etc.) emit { type, payload } without an explicit
    // namespace; our own command messages use namespace 'format' (insert-
    // table, set-cell-shading, update-image-attrs, ...). Both shapes flow
    // through installFormatBridge — mirrors the install pattern of the
    // comment and find-replace bridges.
    useEffect(() => {
        if (!editor) return
        const bridge = installFormatBridge(editor, postToNative)
        return () => bridge.destroy()
    }, [editor])

    useEffect(() => {
        if (!editor) return
        const bridge = installCommentBridge(editor, postToNative)
        return () => bridge.destroy()
    }, [editor])

    useEffect(() => {
        if (!editor) return
        const bridge = installFindReplaceBridge(editor, postToNative)
        return () => bridge.destroy()
    }, [editor])

    // Suggestion list bridge: pushes the current
    // DocumentSuggestionsResult snapshot to the host whenever the
    // editor doc or the suggestions Y.Map changes. The host's
    // useDocumentSuggestionBridge subscribes to these pushes via the
    // 'suggestion.changed' message and surfaces them through the
    // standard subscribe/getSnapshot bridge contract used by the
    // review drawer.
    useEffect(() => {
        if (!editor) return
        return installSuggestionListBridge(editor, yDoc, init.documentId, (kind, payload) => {
            postToNative({ kind, payload })
        })
    }, [editor, yDoc, init.documentId])

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
