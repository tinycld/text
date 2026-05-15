import { eq } from '@tanstack/db'
import { PresenceAvatars } from '@tinycld/core/components/PresenceAvatars'
import { useStore } from '@tinycld/core/lib/pocketbase'
import { useOrgLiveQuery } from '@tinycld/core/lib/use-org-live-query'
import { useLocalSearchParams } from 'expo-router'
import { ActivityIndicator, ScrollView, Text, View } from 'react-native'
import { DocumentToolbar } from '../components/DocumentToolbar'
import { ImportWarningBanner } from '../components/ImportWarningBanner'
import { ReconnectingIndicator } from '../components/ReconnectingIndicator'
import { SaveStatusIndicator } from '../components/SaveStatusIndicator'
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

    return <DocumentScreen itemName={item.name} room={room} driveItemId={item.id} />
}

interface DocumentScreenProps {
    itemName: string
    room: NonNullable<ReturnType<typeof useTextRoom>>
    driveItemId: string
}

function DocumentScreen({ itemName, room, driveItemId }: DocumentScreenProps) {
    const { EditorComponent, commands, toolbarState, saveStatus } = useTextDocument(
        room,
        driveItemId
    )
    const hello = typedServerHello(room)
    const isReadOnly = hello.readOnly

    return (
        <View className="flex-1 bg-background">
            <View className="px-4 py-2 border-b border-border flex-row items-center gap-3">
                <Text className="text-base font-semibold text-foreground flex-1" numberOfLines={1}>
                    {itemName}
                </Text>
                <PresenceAvatars awareness={room.awareness} />
                <SaveStatusIndicator status={saveStatus} />
                <ReconnectingIndicator isVisible={!room.isConnected} />
            </View>
            <ImportWarningBanner warnings={hello.importWarnings} />
            <DocumentToolbar commands={commands} state={toolbarState} disabled={isReadOnly} />
            <ScrollView className="flex-1">
                <View className="p-6 max-w-[800px] w-full self-center">
                    <EditorComponent />
                </View>
            </ScrollView>
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
