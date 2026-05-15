import { and, eq } from '@tanstack/db'
import { useOrgHref } from '@tinycld/core/lib/org-routes'
import { useStore } from '@tinycld/core/lib/pocketbase'
import { useOrgLiveQuery } from '@tinycld/core/lib/use-org-live-query'
import { useCreateDriveItem } from '@tinycld/drive/lib/upload-to-drive'
import { router } from 'expo-router'
import { FilePlus2, FileText } from 'lucide-react-native'
import { useCallback } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { DOCX_MIME_TYPE } from '../lib/mime'

// blankDocxBlob returns an empty Blob carrying the docx mime type. The
// server-side bootstrap hook is responsible for synthesizing a minimal
// valid .docx skeleton when the doc is empty — clients only need a
// mime-type-tagged placeholder so the drive_items row gets created.
function blankDocxBlob(): Blob {
    return new Blob([], { type: DOCX_MIME_TYPE })
}

export default function TextIndex() {
    const orgHref = useOrgHref()
    const [driveItemsCollection] = useStore('drive_items')
    const create = useCreateDriveItem()

    const { data: items = [] } = useOrgLiveQuery((query, { orgId }) =>
        query
            .from({ item: driveItemsCollection })
            .where(({ item }) =>
                and(
                    eq(item.org, orgId),
                    eq(item.mime_type, DOCX_MIME_TYPE),
                    eq(item.is_folder, false)
                )
            )
            .orderBy(({ item }) => item.updated, 'desc')
    )

    const handleNew = useCallback(async () => {
        const result = await create.mutateAsync({
            body: blankDocxBlob(),
            name: 'Untitled.docx',
            mimeType: DOCX_MIME_TYPE,
        })
        router.push(orgHref('text/[id]', { id: result.itemId }))
    }, [create, orgHref])

    const isEmpty = items.length === 0

    return (
        <ScrollView className="flex-1 bg-background">
            <View className="p-6 gap-4">
                <View className="flex-row items-center justify-between">
                    <Text
                        accessibilityRole="header"
                        aria-level={2}
                        className="text-2xl font-semibold text-foreground"
                    >
                        Text
                    </Text>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="New document"
                        onPress={handleNew}
                        disabled={create.isPending}
                        className="flex-row items-center gap-2 px-3 py-2 rounded-md bg-accent"
                    >
                        <FilePlus2 size={16} color="white" />
                        <Text className="text-sm font-medium text-accent-foreground">
                            {create.isPending ? 'Creating…' : 'New document'}
                        </Text>
                    </Pressable>
                </View>

                <EmptyState isVisible={isEmpty && !create.isPending} />

                <View className="gap-1">
                    {items.map(item => (
                        <DocumentRow key={item.id} item={item} />
                    ))}
                </View>
            </View>
        </ScrollView>
    )
}

interface EmptyStateProps {
    isVisible: boolean
}

function EmptyState({ isVisible }: EmptyStateProps) {
    if (!isVisible) return null
    return (
        <View className="py-12 items-center gap-2">
            <FileText size={32} color="#888" />
            <Text className="text-sm text-muted-foreground">No documents yet</Text>
            <Text className="text-xs text-muted-foreground">Create one to get started.</Text>
        </View>
    )
}

interface DocumentRowProps {
    item: { id: string; name: string; updated: string }
}

function DocumentRow({ item }: DocumentRowProps) {
    const orgHref = useOrgHref()
    return (
        <Pressable
            onPress={() => router.push(orgHref('text/[id]', { id: item.id }))}
            className="flex-row items-center gap-3 px-3 py-2 rounded-md hover:bg-surface-secondary"
        >
            <FileText size={20} color="#3b82f6" />
            <View className="flex-1">
                <Text className="text-sm text-foreground" numberOfLines={1}>
                    {item.name}
                </Text>
                <Text className="text-xs text-muted-foreground">{formatUpdated(item.updated)}</Text>
            </View>
        </Pressable>
    )
}

function formatUpdated(iso: string): string {
    if (!iso) return ''
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return ''
    return date.toLocaleDateString()
}
