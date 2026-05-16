import { useOrgHref } from '@tinycld/core/lib/org-routes'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { router } from 'expo-router'
import { FilePlus2, FileText } from 'lucide-react-native'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { useCreateBlankTextDocument, useTextDocuments } from '../hooks/use-text-documents'

export default function TextIndex() {
    const orgHref = useOrgHref()
    const { data: items = [] } = useTextDocuments()
    const { create, isPending } = useCreateBlankTextDocument()
    const accentFg = useThemeColor('accent-foreground')

    const handleNew = () => {
        create(itemId => router.push(orgHref('text/[id]', { id: itemId })))
    }

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
                        disabled={isPending}
                        className="flex-row items-center gap-2 px-3 py-2 rounded-md bg-accent"
                    >
                        <FilePlus2 size={16} color={accentFg} />
                        <Text className="text-sm font-medium text-accent-foreground">
                            {isPending ? 'Creating…' : 'New document'}
                        </Text>
                    </Pressable>
                </View>

                <EmptyState isVisible={isEmpty && !isPending} />

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
    const mutedFg = useThemeColor('muted-foreground')
    if (!isVisible) return null
    return (
        <View className="py-12 items-center gap-2">
            <FileText size={32} color={mutedFg} />
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
    // `primary` is the project's brand teal — the closest semantic match for the
    // original `#3b82f6` file-icon tint. `accent` in this theme is a soft
    // background fill (very pale teal in light mode) and would render invisible
    // here, so we deliberately don't use it.
    const primary = useThemeColor('primary')
    return (
        <Pressable
            onPress={() => router.push(orgHref('text/[id]', { id: item.id }))}
            className="flex-row items-center gap-3 px-3 py-2 rounded-md hover:bg-surface-secondary"
        >
            <FileText size={20} color={primary} />
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
