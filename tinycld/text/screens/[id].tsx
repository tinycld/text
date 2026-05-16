import { eq } from '@tanstack/db'
import { PresenceAvatars } from '@tinycld/core/components/PresenceAvatars'
import { useOrgHref } from '@tinycld/core/lib/org-routes'
import { useStore } from '@tinycld/core/lib/pocketbase'
import { useOrgLiveQuery } from '@tinycld/core/lib/use-org-live-query'
import { CopyToFolderDialog } from '@tinycld/drive/components/CopyToFolderDialog'
import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { ActivityIndicator, Linking, Platform, ScrollView, Text, View } from 'react-native'
import { DocumentContextMenu } from '../components/DocumentContextMenu'
import { DocumentTitle } from '../components/DocumentTitle'
import { DocumentToolbar } from '../components/DocumentToolbar'
import { ImportWarningBanner } from '../components/ImportWarningBanner'
import { LinkPopover } from '../components/LinkPopover'
import { MenuBar } from '../components/menubar/MenuBar'
import { MobileToolbarAccessory } from '../components/MobileToolbarAccessory'
import { ReconnectingIndicator } from '../components/ReconnectingIndicator'
import { SaveStatusIndicator } from '../components/SaveStatusIndicator'
import { useDocumentFileActions } from '../hooks/use-document-file-actions'
import { usePrintDocument } from '../hooks/use-print-document'
import { useTextDocument } from '../hooks/useTextDocument'
import { typedServerHello, useTextRoom } from '../hooks/useTextRoom'

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
    const { EditorComponent, editor, commands, toolbarState, saveStatus } = useTextDocument(
        room,
        driveItemId
    )
    const hello = typedServerHello(room)
    const isReadOnly = hello.readOnly
    const printDocument = usePrintDocument(editor)
    usePrintShortcut(printDocument)
    const fileActions = useDocumentFileActions(driveItemId)
    const orgHref = useOrgHref()
    // Link popover is reached from two surfaces — the toolbar's link
    // button and the context menu's "Insert link" item. We hoist its
    // open state here so both surfaces can drive it; the toolbar still
    // owns its own internal popover for the in-toolbar button path.
    const [contextLinkOpen, setContextLinkOpen] = useState(false)

    return (
        <View className="flex-1 bg-background">
            <View className="px-4 py-2 border-b border-border flex-row items-center gap-3">
                <DocumentTitle
                    documentId={driveItemId}
                    name={itemName}
                    isReadOnly={isReadOnly}
                />
                <PresenceAvatars awareness={room.awareness} />
                <SaveStatusIndicator status={saveStatus} isConnected={room.isConnected} />
                <ReconnectingIndicator isVisible={!room.isConnected} />
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
                onOpenKeyboardShortcuts={() => void Linking.openURL('https://tinycld.org/docs')}
                onRequestInsertLink={() => setContextLinkOpen(true)}
                onInsertImage={dataUri => commands.insertImage?.(dataUri)}
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
        </View>
    )
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
