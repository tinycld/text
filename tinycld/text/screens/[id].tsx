import { eq } from '@tanstack/db'
import { PresenceAvatars } from '@tinycld/core/components/PresenceAvatars'
import type { EditorCommands } from '@tinycld/core/lib/editor/types'
import { useOrgHref } from '@tinycld/core/lib/org-routes'
import { useStore } from '@tinycld/core/lib/pocketbase'
import { useCommentsDrawerStore } from '@tinycld/core/lib/stores/comments-drawer-store'
import { useOrgLiveQuery } from '@tinycld/core/lib/use-org-live-query'
import { CopyToFolderDialog } from '@tinycld/drive/components/CopyToFolderDialog'
import { router, useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Platform, ScrollView, Text, View } from 'react-native'
import { NewCommentButton } from '../components/comments/NewCommentButton'
import { OpenCommentsDrawerButton } from '../components/comments/OpenCommentsDrawerButton'
import { TextCommentDrawer } from '../components/comments/TextCommentDrawer'
import { DocumentContextMenu } from '../components/DocumentContextMenu'
import { DocumentTitle } from '../components/DocumentTitle'
import { DocumentToolbar } from '../components/DocumentToolbar'
import { FindReplaceBar, useFindReplaceShortcuts } from '../components/FindReplaceBar'
import { HelpSearchPalette } from '../components/HelpSearchPalette'
import { useImageInsert } from '../components/ImageInsertButton'
import { ImportWarningBanner } from '../components/ImportWarningBanner'
import { LinkPopover } from '../components/LinkPopover'
import { MenuBar } from '../components/menubar/MenuBar'
import { MobileToolbarAccessory } from '../components/MobileToolbarAccessory'
import { ReconnectingIndicator } from '../components/ReconnectingIndicator'
import { SaveStatusIndicator } from '../components/SaveStatusIndicator'
import { SlashMenu } from '../components/SlashMenu'
import { WordCountBadge } from '../components/WordCountBadge'
import { useDocumentComments } from '../hooks/use-document-comments'
import { useDocumentFileActions } from '../hooks/use-document-file-actions'
import { useHelpSearchShortcut } from '../hooks/use-help-search-shortcut'
import { usePrintDocument } from '../hooks/use-print-document'
import { useTextDocument } from '../hooks/useTextDocument'
import { typedServerHello, useTextRoom } from '../hooks/useTextRoom'
import { FindReplaceEditorContext } from '../lib/find-replace-editor-context'
import { useFindReplaceStore } from '../lib/stores/find-replace-store'

export default function TextDetail() {
    const { id } = useLocalSearchParams<{ id: string }>()
    const [driveItemsCollection] = useStore('drive_items')

    const { data: items = [], isLoading: isItemLoading } = useOrgLiveQuery(
        (query, { orgId }) =>
            query
                .from({ item: driveItemsCollection })
                .where(({ item }) => eq(item.org, orgId))
                .where(({ item }) => eq(item.id, id ?? '')),
        [id]
    )

    const item = items[0]

    // Open the realtime room as soon as we have a document id. The
    // server populates the doc from the source .docx before the first
    // SyncReply arrives, so the client never needs the file source.
    const room = useTextRoom(item?.id ?? '')

    if (isItemLoading || !item) {
        return <CenteredMessage label="Loading document…" spinner />
    }

    if (room == null || !room.isReady) {
        return <CenteredMessage label="Opening…" spinner />
    }

    return (
        <DocumentScreen
            itemName={item.name}
            itemFile={item.file ?? ''}
            room={room}
            driveItemId={item.id}
        />
    )
}

interface DocumentScreenProps {
    itemName: string
    itemFile: string
    room: NonNullable<ReturnType<typeof useTextRoom>>
    driveItemId: string
}

function DocumentScreen({ itemName, itemFile, room, driveItemId }: DocumentScreenProps) {
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
    const {
        EditorComponent,
        editor,
        commands,
        toolbarState,
        saveStatus,
        tiptapEditor,
        findReplaceEditor,
        commentBridge,
    } = useTextDocument(room, driveItemId, {
        onRequestInsertImage: openSlashMenuImage,
    })
    commandsRef.current = commands
    const hello = typedServerHello(room)
    const isReadOnly = hello.readOnly
    const printDocument = usePrintDocument(editor)
    usePrintShortcut(printDocument)
    useHelpSearchShortcut()
    const fileActions = useDocumentFileActions(driveItemId)
    const orgHref = useOrgHref()
    // Link popover is reached from two surfaces — the toolbar's link
    // button and the context menu's "Insert link" item. We hoist its
    // open state here so both surfaces can drive it; the toolbar still
    // owns its own internal popover for the in-toolbar button path.
    const [contextLinkOpen, setContextLinkOpen] = useState(false)
    const documentComments = useDocumentComments(driveItemId, commentBridge)
    useCommentsLifecycle(driveItemId)

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
                    <WordCountBadge editor={tiptapEditor} />
                    <ReconnectingIndicator isVisible={!room.isConnected} />
                    <View className="ml-auto flex-row items-center gap-1">
                        <NewCommentButton
                            driveItemId={driveItemId}
                            commentBridge={commentBridge}
                            selectionEmpty={toolbarState.selectionEmpty ?? true}
                            disabled={isReadOnly}
                        />
                        <OpenCommentsDrawerButton driveItemId={driveItemId} />
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
                    onPrint={() => {
                        void printDocument()
                    }}
                    onRequestInsertLink={() => setContextLinkOpen(true)}
                    onInsertImage={url => commands.insertImage?.(url)}
                />
                <DocumentToolbar commands={commands} state={toolbarState} disabled={isReadOnly} />
                <DocumentContextMenu
                    commands={commands}
                    toolbarState={toolbarState}
                    editable={!isReadOnly}
                    onRequestInsertLink={() => setContextLinkOpen(true)}
                    className="flex-1"
                >
                    <ScrollView className="flex-1">
                        <View className="p-6 max-w-[800px] w-full self-center">
                            <EditorComponent />
                            <FindReplaceShell />
                        </View>
                    </ScrollView>
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
                <CopyToFolderDialog
                    itemId={driveItemId}
                    onCopied={newItemId =>
                        router.replace(orgHref('text/[id]', { id: newItemId }))
                    }
                />
                <TextCommentDrawer
                    driveItemId={driveItemId}
                    documentComments={documentComments}
                    commentBridge={commentBridge}
                />
                <SlashMenu />
                <HelpSearchPalette />
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
