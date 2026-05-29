import { eq } from '@tanstack/db'
import { PresenceAvatars } from '@tinycld/core/components/PresenceAvatars'
import { useAuth } from '@tinycld/core/lib/auth'
import { type EditorMount, EditorMountProvider } from '@tinycld/core/lib/editor/editor-mount'
import type { EditorCommands } from '@tinycld/core/lib/editor/types'
import { useOrgHref } from '@tinycld/core/lib/org-routes'
import { useStore } from '@tinycld/core/lib/pocketbase'
import { useCommentsDrawerStore } from '@tinycld/core/lib/stores/comments-drawer-store'
import { useCurrentRole } from '@tinycld/core/lib/use-current-role'
import { useDocumentTitle } from '@tinycld/core/lib/use-document-title'
import { useOrgLiveQuery } from '@tinycld/core/lib/use-org-live-query'
import { CopyToFolderDialog } from '@tinycld/drive/components/CopyToFolderDialog'
import type { Editor as TiptapEditor } from '@tiptap/react'
import { router, useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ActivityIndicator, Platform, ScrollView, Text, View } from 'react-native'
import * as Y from 'yjs'
import { OpenCommentsDrawerButton } from '../components/comments/OpenCommentsDrawerButton'
import { TextCommentDrawer } from '../components/comments/TextCommentDrawer'
import { DocumentContextMenu } from '../components/DocumentContextMenu'
import { DocumentTitle } from '../components/DocumentTitle'
import { DocumentToolbar } from '../components/DocumentToolbar'
import { FindReplaceBar, useFindReplaceShortcuts } from '../components/FindReplaceBar'
import { ImageAttrsBottomSheet } from '../components/ImageAttrsBottomSheet'
import { useImageInsert } from '../components/ImageInsertButton'
import { ImportWarningBanner } from '../components/ImportWarningBanner'
import { LinkPopover } from '../components/LinkPopover'
import { MobileToolbarAccessory } from '../components/MobileToolbarAccessory'
import { MenuBar } from '../components/menubar/MenuBar'
import { ReconnectingIndicator } from '../components/ReconnectingIndicator'
import { SaveStatusIndicator } from '../components/SaveStatusIndicator'
import { SlashMenu } from '../components/SlashMenu'
import { AuthorshipPopover } from '../components/suggestions/AuthorshipPopover'
import { ReviewDrawer } from '../components/suggestions/ReviewDrawer'
import { WordCountBadge } from '../components/WordCountBadge'
import { useClientAuthors } from '../hooks/use-client-authors'
import { useDocumentComments } from '../hooks/use-document-comments'
import { useDocumentFileActions } from '../hooks/use-document-file-actions'
import type { DocumentSuggestionsResult } from '../hooks/use-document-suggestions'
import { useNewCommentFlow } from '../hooks/use-new-comment-flow'
import { usePrintDocument } from '../hooks/use-print-document'
import { useResolveSuggestionService } from '../hooks/use-resolve-suggestion'
import { useDocumentSuggestionBridge } from '../hooks/use-suggestion-bridge'
import type { NativeSuggestionBridge } from '../hooks/use-suggestion-bridge.native'
import { useSuggestionPermissions } from '../hooks/use-suggestion-permissions'
import { useTextDocument } from '../hooks/useTextDocument'
import { typedServerHello, useTextRoom } from '../hooks/useTextRoom'
import { subscribeUiMessage } from '../lib/anchored-overlay/ui-message-bus'
import {
    aggregateContributors,
    type ContributorSummary,
} from '../lib/authorship/aggregate-contributors'
import { walkParagraphAuthors } from '../lib/authorship/walk-paragraph-authors'
import { colorForUser } from '../lib/color-for-user'
import { FindReplaceEditorContext } from '../lib/find-replace-editor-context'
import { useFindReplaceStore } from '../lib/stores/find-replace-store'
import { bulkAccept, bulkReject } from '../lib/suggestions/bulk-resolve'
import { createEditorModeStore, EDITOR_MODE_VIEWING } from '../stores/editor-mode-store'
import { createReviewDrawerStore } from '../stores/review-drawer-store'

// Stable identity for the empty-state snapshot. useSyncExternalStore
// reads getSnapshot every render and requires a stable reference when
// nothing has changed; returning a fresh object literal would trip
// React's "result of getSnapshot should be cached" warning.
const EMPTY_SUGGESTIONS_RESULT: DocumentSuggestionsResult = { anchored: [], orphaned: [] }

export function TextEditorFromMount({ mount }: { mount: EditorMount }) {
    const room = useTextRoom(mount.itemId, {
        identity: mount.identity,
        realtimeCredential: mount.realtimeCredential,
    })

    if (room == null || !room.isReady) {
        return <CenteredMessage label="Opening…" spinner />
    }

    return (
        <EditorMountProvider value={mount}>
            <DocumentScreen
                itemName={mount.itemName}
                itemFile={mount.itemFile}
                room={room}
                driveItemId={mount.itemId}
            />
        </EditorMountProvider>
    )
}

export default function TextDetail() {
    const { id } = useLocalSearchParams<{ id: string }>()
    const [driveItemsCollection] = useStore('drive_items')
    const { user } = useAuth()
    const { userOrgId } = useCurrentRole()

    const { data: items = [], isLoading: isItemLoading } = useOrgLiveQuery(
        (query, { orgId }) =>
            query
                .from({ item: driveItemsCollection })
                .where(({ item }) => eq(item.org, orgId))
                .where(({ item }) => eq(item.id, id ?? '')),
        [id]
    )

    const item = items[0]

    useDocumentTitle(item?.name ? `Text — ${item.name}` : 'Text')

    if (isItemLoading || !item) {
        return <CenteredMessage label="Loading document…" spinner />
    }

    const mount: EditorMount = {
        itemId: item.id,
        itemName: item.name,
        itemFile: item.file ?? '',
        mimeType: item.mime_type ?? '',
        // Authed org member: full identity + all capabilities. The anon/guest
        // mount (built on the share route) is a later task.
        identity: {
            kind: 'member',
            userId: user.id,
            userOrgId,
            displayName: user.name,
            color: colorForUser(user.id),
        },
        role: 'editor',
        capabilities: {
            canEdit: true,
            canComment: true,
            canUseFileActions: true,
            canMention: true,
        },
        realtimeCredential: { kind: 'auth' },
    }

    return <TextEditorFromMount mount={mount} />
}

interface DocumentScreenProps {
    itemName: string
    itemFile: string
    room: NonNullable<ReturnType<typeof useTextRoom>>
    driveItemId: string
}

function DocumentScreen({ itemName, itemFile, room, driveItemId }: DocumentScreenProps) {
    // Dev-only window hook exposing the live Y.Doc for e2e specs to
    // page.evaluate against (e.g. the Phase 3a authorship-stamping spec
    // reads doc.getMap('clientAuthors')). Gated on __DEV__ so production
    // bundles ship without the hook. Web-only — native runs the editor
    // inside a WebView and doesn't expose a host-side `window`.
    useDevYDocWindowHook(room.doc)
    // The slash menu's "Image" entry routes through the same picker +
    // drive-upload pipeline the toolbar's image button uses. The picker
    // resolves async, by which point `commands` will have been bound;
    // a ref-backed indirection lets us pass a stable callback into
    // useDocumentEditor (which expects a stable identity in its deps
    // array) while still reaching into the live commands object the
    // hook returns to us.
    const commandsRef = useRef<EditorCommands | null>(null)
    const handleSlashMenuImageInserted = useCallback((url: string) => {
        commandsRef.current?.insertImage?.(url)
    }, [])
    const triggerSlashMenuImage = useImageInsert(handleSlashMenuImageInserted)
    const openSlashMenuImage = useCallback(() => {
        triggerSlashMenuImage()
    }, [triggerSlashMenuImage])
    // One mode store per open document. The store is reference-stable
    // across renders (so the editor mounts and command layer subscribe
    // exactly once), and is recreated only when the document remounts.
    // Identity is wired separately below via setIdentity — the store
    // starts with `identity: null` and the command layer's mode check
    // gates writes until both mode === 'suggesting' and identity is set.
    const modeStore = useMemo(() => createEditorModeStore(), [])
    // One review-drawer store per open document — same scope rule as
    // modeStore. Recreated when the document remounts so a stale
    // focusedSuggestionId from doc A can't focus an unrelated row in
    // doc B after navigation.
    const reviewDrawerStore = useMemo(() => createReviewDrawerStore(), [])
    const { userOrgId } = useCurrentRole()
    useEffect(() => {
        if (userOrgId) {
            modeStore.getState().setIdentity({ userOrgId })
        } else {
            modeStore.getState().setIdentity(null)
        }
    }, [userOrgId, modeStore])
    // The suggestion bridge is created below (it needs tiptapEditor +
    // yDoc, which come out of useTextDocument). But the native variant
    // of useTextDocument needs an onSuggestionMessage callback to wire
    // into the WebView's onMessage path. Bridge messages arrive after
    // tiptapEditor mounts, so the ordering works: the callback closes
    // over a ref that's filled in once the bridge exists, and bridge
    // messages before the bridge mounts are dropped on the floor
    // (the WebView posts an initial snapshot on mount, and the bridge
    // observer pushes updates as state changes).
    const nativeBridgeRef = useRef<NativeSuggestionBridge | null>(null)
    const onSuggestionMessage = useCallback((kind: string, payload: unknown) => {
        nativeBridgeRef.current?.processIncomingMessage(kind, payload)
    }, [])
    const {
        EditorComponent,
        commands,
        toolbarState,
        saveStatus,
        tiptapEditor,
        findReplaceEditor,
        commentBridge,
        webViewRef,
    } = useTextDocument(room, driveItemId, {
        onRequestInsertImage: openSlashMenuImage,
        modeStore,
        onSuggestionMessage,
    })
    commandsRef.current = commands
    // Dev-only window hook exposing the live Tiptap editor for e2e
    // specs to drive deterministically via .chain() commands. Same
    // gating + cleanup pattern as useDevYDocWindowHook above. The e2e
    // suite uses this to position the caret and select ranges without
    // relying on platform-specific keyboard shortcut behavior (⌘+End
    // on Mac, for instance, can be preempted by the OS-level binding
    // and land at end-of-line rather than end-of-doc).
    useDevTiptapEditorWindowHook(tiptapEditor)
    const hello = typedServerHello(room)
    const isReadOnly = hello.readOnly
    const { canEdit, canSuggest, canResolve } = useSuggestionPermissions(driveItemId)

    // Suggestion review pipeline. The bridge surfaces the same
    // anchored/orphaned shape on both platforms: on web it walks the
    // host's editor + Y.Map directly; on native it accumulates the
    // WebView's pushed snapshots via onSuggestionMessage. The screen
    // doesn't have to know which path applies — the platform-resolved
    // useDocumentSuggestionBridge picks .web/.native automatically.
    const suggestionBridge = useDocumentSuggestionBridge({
        driveItemId,
        yDoc: room.doc,
        editor: tiptapEditor,
    })
    // Cast the bridge to its native concrete type so the ref-backed
    // callback above can call processIncomingMessage. On web the cast
    // is a lie (web's bridge doesn't expose processIncomingMessage),
    // but onSuggestionMessage is never invoked there — useWebViewEditor
    // doesn't run, and Platform.OS === 'web' callers never reach the
    // WebView message path.
    nativeBridgeRef.current = suggestionBridge as unknown as NativeSuggestionBridge | null
    const subscribeBridge = useCallback(
        (handler: () => void) => suggestionBridge?.subscribe(handler) ?? (() => {}),
        [suggestionBridge]
    )
    const getBridgeSnapshot = useCallback(
        (): DocumentSuggestionsResult =>
            suggestionBridge?.getSnapshot() ?? EMPTY_SUGGESTIONS_RESULT,
        [suggestionBridge]
    )
    const { anchored, orphaned } = useSyncExternalStore(subscribeBridge, getBridgeSnapshot)
    const resolveService = useResolveSuggestionService({
        editor: tiptapEditor,
        yDoc: room.doc,
    })
    const onBulkAccept = useCallback(
        (ids: string[]) => {
            if (!tiptapEditor || !room.doc || !userOrgId) return
            bulkAccept(tiptapEditor, ids, {
                resolverUserOrgId: userOrgId,
                yDoc: room.doc,
            })
        },
        [tiptapEditor, room.doc, userOrgId]
    )
    const onBulkReject = useCallback(
        (ids: string[]) => {
            if (!tiptapEditor || !room.doc || !userOrgId) return
            bulkReject(tiptapEditor, ids, {
                resolverUserOrgId: userOrgId,
                yDoc: room.doc,
            })
        },
        [tiptapEditor, room.doc, userOrgId]
    )

    // Reflect the editor mode into the Tiptap editor's editable flag so
    // 'viewing' mode is read-only at the editor level. Other modes stay
    // editable; the command layer (lib/suggestions/command-layer.ts)
    // gates whether 'suggesting'-mode edits become real-text or
    // suggestion marks. Native is a no-op — tiptapEditor is null
    // because the WebView owns the editor, and viewing-mode read-only
    // wiring on native is handled by a different code path (the
    // existing editable flag passed to the WebView).
    useEffect(() => {
        if (!tiptapEditor) return
        const updateEditable = () => {
            const { mode } = modeStore.getState()
            tiptapEditor.setEditable(mode !== EDITOR_MODE_VIEWING)
        }
        updateEditable()
        const unsubscribe = modeStore.subscribe(updateEditable)
        return unsubscribe
    }, [tiptapEditor, modeStore])

    // Coerce mode to Viewing for viewer-role users so the toolbar
    // dropdown's label matches the only available option. Without
    // this, a pure viewer (no edit, no suggest) sees the trigger read
    // 'Editing' until they open the dropdown, even though every option
    // except Viewing is hidden.
    //
    // Force Viewing only when the server's hello.readOnly flag is
    // truthy. The client-side useSuggestionPermissions hook returns
    // canEdit=false during the initial render window before
    // drive_shares rows have loaded; without the hello.readOnly gate
    // we'd flip every editor user into Viewing on first paint and
    // they'd be stuck there (the effect doesn't fire back when
    // canEdit later becomes true). hello.readOnly is server-authoritative
    // and arrives in the first SyncReply, so it's both the right
    // signal and racier-than-the-rows.
    useEffect(() => {
        if (isReadOnly) {
            modeStore.getState().setMode(EDITOR_MODE_VIEWING)
        }
    }, [isReadOnly, modeStore])

    // Authorship blame popover. Right-click on a paragraph (web only)
    // resolves the targeted block to its Y.XmlText, walks the per-author
    // run list via walkParagraphAuthors, and opens a popover anchored to
    // the cursor coordinates. The screen owns the state because the
    // popover is rendered at screen scope (positioned absolutely over
    // the editor) and the contextmenu listener has to attach to the
    // editor's DOM container — both reads that live above the editor's
    // own hook.
    const clientAuthors = useClientAuthors(room.doc)
    const [authorshipPopover, setAuthorshipPopover] = useState<{
        x: number
        y: number
        contributors: ContributorSummary[]
    } | null>(null)
    useAuthorshipContextMenu({
        tiptapEditor,
        yDoc: room.doc,
        clientAuthors,
        onOpen: setAuthorshipPopover,
    })

    // Print routes through the server's /api/text/render endpoint
    // — no longer needs the editor handle. Print works even if the
    // editor isn't mounted yet (e.g. from the share screen).
    const printDocument = usePrintDocument(driveItemId)
    usePrintShortcut(printDocument)
    const fileActions = useDocumentFileActions(driveItemId)
    const orgHref = useOrgHref()
    // Link popover is reached from two surfaces — the toolbar's link
    // button and the context menu's "Insert link" item. We hoist its
    // open state here so both surfaces can drive it; the toolbar still
    // owns its own internal popover for the in-toolbar button path.
    const [contextLinkOpen, setContextLinkOpen] = useState(false)
    const documentComments = useDocumentComments(driveItemId, commentBridge)
    useCommentsLifecycle(driveItemId)
    useCommentTapHandler(driveItemId, commentBridge, documentComments)
    useSuggestionClickHandler(driveItemId, reviewDrawerStore)
    const newCommentFlow = useNewCommentFlow({
        driveItemId,
        commentBridge,
        selectionEmpty: toolbarState.selectionEmpty ?? true,
        editable: !isReadOnly,
    })

    // Open (unresolved, non-orphaned) thread count drives the badge on
    // the OpenCommentsDrawerButton. Recomputes when threads or the
    // orphan set change.
    const openThreadCount = useMemo(() => {
        const { threadsByCommentId, orphanedCommentIds } = documentComments
        let count = 0
        for (const [commentId, threads] of threadsByCommentId) {
            if (orphanedCommentIds.has(commentId)) continue
            for (const t of threads) {
                if (t.resolvedAt == null) count += 1
            }
        }
        return count
    }, [documentComments])

    return (
        <FindReplaceEditorContext.Provider value={findReplaceEditor}>
            <View className="flex-1 bg-background">
                <View className="px-4 py-2 border-b border-border flex-row items-center gap-3">
                    <DocumentTitle
                        documentId={driveItemId}
                        name={itemName}
                        isReadOnly={isReadOnly}
                    />
                    <PresenceAvatars awareness={room.awareness} />
                    <SaveStatusIndicator status={saveStatus} isConnected={room.isConnected} />
                    <WordCountBadge wordCount={toolbarState.wordCount} />
                    <ReconnectingIndicator isVisible={!room.isConnected} />
                    <View className="ml-auto flex-row items-center gap-1">
                        <OpenCommentsDrawerButton
                            driveItemId={driveItemId}
                            openCount={openThreadCount}
                        />
                    </View>
                </View>
                <ImportWarningBanner warnings={hello.importWarnings} />
                <MenuBar
                    documentName={itemName}
                    documentId={driveItemId}
                    sourceFile={itemFile}
                    commands={commands}
                    toolbarState={toolbarState}
                    fileActions={fileActions}
                    disabled={isReadOnly}
                    isReadOnly={isReadOnly}
                    onPrint={() => {
                        void printDocument()
                    }}
                    onRequestInsertLink={() => setContextLinkOpen(true)}
                    onInsertImage={url => commands.insertImage?.(url)}
                    tiptapEditor={tiptapEditor}
                />
                <DocumentToolbar
                    commands={commands}
                    state={toolbarState}
                    disabled={isReadOnly}
                    newCommentFlow={{
                        canStart: newCommentFlow.canStart,
                        isOpen: newCommentFlow.isOpen,
                        start: newCommentFlow.start,
                    }}
                    modeStore={modeStore}
                    canEdit={canEdit}
                    canSuggest={canSuggest}
                    reviewDrawerStore={reviewDrawerStore}
                    driveItemId={driveItemId}
                />
                <DocumentContextMenu
                    commands={commands}
                    toolbarState={toolbarState}
                    editable={!isReadOnly}
                    onRequestInsertLink={() => setContextLinkOpen(true)}
                    onRequestAddComment={newCommentFlow.start}
                    canAddComment={newCommentFlow.canStart}
                    className="flex-1"
                >
                    {Platform.OS === 'web' ? (
                        <ScrollView className="flex-1">
                            <View className="p-6 max-w-[800px] w-full self-center">
                                <EditorComponent />
                                <FindReplaceShell />
                            </View>
                        </ScrollView>
                    ) : (
                        <View className="flex-1">
                            <EditorComponent />
                            <FindReplaceShell />
                        </View>
                    )}
                </DocumentContextMenu>
                <LinkPopover
                    isOpen={contextLinkOpen}
                    initialUrl={toolbarState.currentLink ?? ''}
                    onCancel={() => setContextLinkOpen(false)}
                    onInsert={url => {
                        if (url) {
                            commands.setLink(url)
                        } else {
                            commands.removeLink()
                        }
                        setContextLinkOpen(false)
                    }}
                />
                <MobileToolbarAccessory
                    commands={commands}
                    toolbarState={toolbarState}
                    editable={!isReadOnly}
                />
                <ImageAttrsBottomSheet editable={!isReadOnly} commands={commands} />
                <CopyToFolderDialog
                    itemId={driveItemId}
                    onCopied={newItemId => router.replace(orgHref('text/[id]', { id: newItemId }))}
                />
                <TextCommentDrawer
                    driveItemId={driveItemId}
                    documentComments={documentComments}
                    commentBridge={commentBridge}
                />
                <ReviewDrawer
                    driveItemId={driveItemId}
                    store={reviewDrawerStore}
                    anchored={anchored}
                    orphaned={orphaned}
                    canResolve={canResolve}
                    isPending={resolveService.isPending}
                    onAccept={resolveService.accept}
                    onReject={resolveService.reject}
                    onBulkAccept={onBulkAccept}
                    onBulkReject={onBulkReject}
                    onJump={s => {
                        if (!tiptapEditor) return
                        tiptapEditor.commands.focus(s.anchorRange.from)
                        reviewDrawerStore.getState().focusSuggestion(s.id)
                    }}
                    yDoc={room.doc}
                    editor={tiptapEditor ?? null}
                />
                {newCommentFlow.modal}
                <SlashMenu
                    webViewRef={webViewRef ?? null}
                    editor={tiptapEditor ?? null}
                    yDoc={room.doc}
                    canResolve={canResolve}
                />
                <AuthorshipPopover
                    isOpen={authorshipPopover !== null}
                    position={
                        authorshipPopover === null
                            ? null
                            : { x: authorshipPopover.x, y: authorshipPopover.y }
                    }
                    contributors={authorshipPopover?.contributors ?? []}
                    onClose={() => setAuthorshipPopover(null)}
                />
            </View>
        </FindReplaceEditorContext.Provider>
    )
}

// Lifecycle owner for the comments drawer at the document level.
// Resets the store when driveItemId changes so a navigation between
// documents can't leak focusedThreadId or an open drawer; reads the
// ?thread=<id> query param on mount so deep links land focused.
function useCommentsLifecycle(driveItemId: string) {
    const reset = useCommentsDrawerStore(s => s.reset)
    const open = useCommentsDrawerStore(s => s.open)
    const { thread } = useLocalSearchParams<{ thread?: string }>()

    useEffect(() => {
        reset()
        if (thread) {
            open({ packageSlug: 'text', driveItemId, threadId: thread })
        }
        return () => reset()
    }, [driveItemId, thread, reset, open])
}

// Bridges editor mark taps to the comments drawer. The bridge gives us
// a commentId (the mark's group key); the store focuses on a thread
// root id, so we resolve via the screen's already-built thread map.
// Reading the map through a ref keeps the bridge subscription stable
// across keystrokes — re-subscribing on every transaction would drop
// taps that arrive between unsubscribe and resubscribe.
function useCommentTapHandler(
    driveItemId: string,
    commentBridge: ReturnType<typeof useTextDocument>['commentBridge'],
    documentComments: ReturnType<typeof useDocumentComments>
) {
    const open = useCommentsDrawerStore(s => s.open)
    const threadsRef = useRef(documentComments.threadsByCommentId)
    threadsRef.current = documentComments.threadsByCommentId

    useEffect(() => {
        if (!commentBridge) return
        return commentBridge.onTap(commentId => {
            const threadId = threadsRef.current.get(commentId)?.[0]?.root.id ?? null
            open({
                packageSlug: 'text',
                driveItemId,
                threadId: threadId ?? undefined,
            })
        })
    }, [commentBridge, driveItemId, open])
}

// Bridges suggestion-decoration clicks to the review drawer: the click
// plugin (lib/suggestions/click-to-focus.ts) publishes a
// 'suggestion-clicked' ui-bus message carrying the suggestionId; here
// we open the drawer for this doc and focus the matching row. Same
// shape as useCommentTapHandler — both surfaces open their respective
// drawers from an in-document tap, side-stepping the inline tooltip
// pattern Google Docs deprecates in favor of the always-on sidebar.
function useSuggestionClickHandler(
    driveItemId: string,
    reviewDrawerStore: ReturnType<typeof createReviewDrawerStore>
) {
    useEffect(() => {
        return subscribeUiMessage(message => {
            if (message.namespace !== 'ui') return
            if (message.type !== 'suggestion-clicked') return
            const payload = message.payload as { suggestionId?: unknown }
            if (typeof payload.suggestionId !== 'string') return
            const state = reviewDrawerStore.getState()
            state.open(driveItemId)
            state.focusSuggestion(payload.suggestionId)
        })
    }, [driveItemId, reviewDrawerStore])
}

interface CenteredMessageProps {
    label: string
    spinner?: boolean
}

function CenteredMessage({ label, spinner }: CenteredMessageProps) {
    return (
        <View className="flex-1 items-center justify-center gap-3 bg-background">
            {spinner ? <ActivityIndicator /> : null}
            <Text className="text-sm text-muted-foreground">{label}</Text>
        </View>
    )
}

// FindReplaceShell sits inside the FindReplaceEditorContext.Provider
// the screen wraps the document tree with, so useFindReplaceEditor()
// resolves the tiptap editor that the shell's `useFindReplaceShortcuts`
// + the bar's action buttons need to dispatch into. Toggles the bar
// on the store's isOpen flag.
function FindReplaceShell() {
    const isOpen = useFindReplaceStore(s => s.isOpen)
    useFindReplaceShortcuts()
    return <FindReplaceBar isVisible={isOpen} />
}

// __DEV__ is Metro/Expo's globally-injected dev gate (`true` for the
// dev server, `false` for production bundles). Declare it locally so
// TypeScript accepts the reference without a global ambient.
declare const __DEV__: boolean

// Exposes the room's Y.Doc on window as a dev-tool hook for Playwright
// specs that need to inspect Y.Doc state via page.evaluate (e.g. the
// authorship-stamping spec asserts on doc.getMap('clientAuthors')).
// Gated on __DEV__ + window so the hook stays out of production bundles
// and out of the native runtime (RN has no DOM window). The yDoc
// identity is stable across renders within a mounted room, so the
// effect runs once on mount.
function useDevYDocWindowHook(yDoc: unknown): void {
    useEffect(() => {
        if (!__DEV__) return
        if (typeof window === 'undefined') return
        ;(window as unknown as { __tinyTextDoc?: unknown }).__tinyTextDoc = yDoc
        return () => {
            const w = window as unknown as { __tinyTextDoc?: unknown }
            if (w.__tinyTextDoc === yDoc) delete w.__tinyTextDoc
        }
    }, [yDoc])
}

// Dev-only window hook exposing the live Tiptap editor instance to
// e2e specs. Mirrors useDevYDocWindowHook's gating: only attaches in
// dev builds (__DEV__), only on web (no `window` on native), and
// cleans up on unmount or editor swap. e2e specs that need to drive
// the editor deterministically (focus end, select a known text range,
// run a command) reach through `window.__tinyTextEditor` rather than
// fighting keyboard shortcuts whose OS-level bindings may preempt
// Tiptap's keymap (notably ⌘+End on macOS).
function useDevTiptapEditorWindowHook(editor: unknown): void {
    useEffect(() => {
        if (!__DEV__) return
        if (typeof window === 'undefined') return
        if (!editor) return
        ;(window as unknown as { __tinyTextEditor?: unknown }).__tinyTextEditor = editor
        return () => {
            const w = window as unknown as { __tinyTextEditor?: unknown }
            if (w.__tinyTextEditor === editor) delete w.__tinyTextEditor
        }
    }, [editor])
}

// Authorship blame popover trigger. Installs a `contextmenu` listener
// on the editor's DOM container (web only) — right-clicking inside the
// editor resolves the clicked block to its Y.XmlText, computes a per-
// author run list via walkParagraphAuthors, aggregates the runs into
// ContributorSummary[], and opens the popover at the cursor coordinates.
//
// PM-pos → YText mapping: the y-tiptap fork's Collaboration extension
// binds the editor to a Y.XmlFragment whose children correspond 1:1
// with the PM doc's top-level blocks. For a block at PM doc index N
// (read via $pos.index(0) on the resolved PM position), the matching
// YXmlElement is yFragment.get(N) and the inline text content lives in
// that element's first child (a Y.XmlText). If the editor schema ever
// nests blocks deeper than one level (e.g. a paragraph inside a list
// item), this mapping no longer holds — the listener falls back to the
// whole-doc aggregator in that case so a right-click in a nested block
// still surfaces *some* attribution data instead of silently no-op'ing.
//
// The listener fires on `contextmenu` (right-click) and preventDefault's
// the browser's native menu only when we have a popover to show. When
// there's no editor / no yDoc / no PM position under the cursor we
// return early without preventing default, so the native menu still
// surfaces in those cases.
interface AuthorshipContextMenuOptions {
    tiptapEditor: TiptapEditor | null
    yDoc: Y.Doc | null
    clientAuthors: Map<number, string>
    onOpen: (popover: { x: number; y: number; contributors: ContributorSummary[] }) => void
}

function useAuthorshipContextMenu(opts: AuthorshipContextMenuOptions) {
    const { tiptapEditor, yDoc, clientAuthors, onOpen } = opts
    const clientAuthorsRef = useRef(clientAuthors)
    clientAuthorsRef.current = clientAuthors
    const onOpenRef = useRef(onOpen)
    onOpenRef.current = onOpen

    useEffect(() => {
        if (Platform.OS !== 'web') return
        if (tiptapEditor === null || yDoc === null) return
        const dom = tiptapEditor.view.dom
        if (!(dom instanceof HTMLElement)) return

        const handler = (e: MouseEvent) => {
            const view = tiptapEditor.view
            const coords = view.posAtCoords({ left: e.clientX, top: e.clientY })
            if (coords === null) return
            const $pos = view.state.doc.resolve(coords.pos)
            // $pos.depth === 0 means the cursor landed on the doc itself
            // (between top-level blocks); $pos.index(0) is the index of
            // the top-level block containing the position. We always read
            // index(0) so a click in a nested block (e.g. paragraph
            // inside a list item) still resolves to the enclosing
            // top-level block — the corresponding YXmlElement at the
            // fragment level — which is the closest the public API gets
            // us without diving into y-prosemirror's mapping table.
            const blockIndex = $pos.depth >= 1 ? $pos.index(0) : 0

            const yFragment = yDoc.getXmlFragment('prosemirror')
            const yBlock = yFragment.get(blockIndex)
            let contributors: ContributorSummary[] = []
            if (yBlock instanceof Y.XmlElement) {
                const firstChild = yBlock.firstChild
                if (firstChild instanceof Y.XmlText) {
                    contributors = summarizeRuns(
                        walkParagraphAuthors(firstChild, clientAuthorsRef.current)
                    )
                }
            }
            // Fallback: if we couldn't resolve a paragraph-scope Y.XmlText
            // (nested block schema, empty paragraph, or fragment shape we
            // didn't expect), surface the whole-doc attribution so the
            // popover still has something to show instead of being empty.
            if (contributors.length === 0) {
                contributors = aggregateContributors(yFragment, clientAuthorsRef.current)
            }

            e.preventDefault()
            onOpenRef.current({
                x: e.clientX,
                y: e.clientY,
                contributors,
            })
        }

        dom.addEventListener('contextmenu', handler)
        return () => {
            dom.removeEventListener('contextmenu', handler)
        }
    }, [tiptapEditor, yDoc])
}

// summarizeRuns collapses an ordered AuthorshipRun[] into per-author
// ContributorSummary entries (authorId + charCount + percent). Mirrors
// what aggregateContributors does for the whole doc but scoped to a
// single paragraph's runs, so the popover can show per-paragraph
// attribution without re-walking the entire fragment.
function summarizeRuns(runs: ReturnType<typeof walkParagraphAuthors>): ContributorSummary[] {
    const totals = new Map<string | null, number>()
    let grandTotal = 0
    for (const run of runs) {
        const len = run.to - run.from
        totals.set(run.authorId, (totals.get(run.authorId) ?? 0) + len)
        grandTotal += len
    }
    const out: ContributorSummary[] = []
    for (const [authorId, charCount] of totals.entries()) {
        out.push({
            authorId,
            charCount,
            percent: grandTotal > 0 ? Math.round((charCount / grandTotal) * 100) : 0,
        })
    }
    out.sort((a, b) => b.charCount - a.charCount)
    return out
}

// Bind ⌘P / Ctrl+P → print. Web-only: native has no equivalent
// keyboard surface, and the upcoming menubar work will wire the
// platform-appropriate trigger for mobile.
function usePrintShortcut(printDocument: () => Promise<void>) {
    useEffect(() => {
        if (Platform.OS !== 'web' || typeof document === 'undefined') return
        const onKeyDown = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') {
                e.preventDefault()
                void printDocument()
            }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
    }, [printDocument])
}
