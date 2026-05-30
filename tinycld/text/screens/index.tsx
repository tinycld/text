import { captureException } from '@tinycld/core/lib/errors'
import { useOrgHref } from '@tinycld/core/lib/org-routes'
import { useToastStore } from '@tinycld/core/lib/stores/toast-store'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { NoFilePanel } from '@tinycld/drive/components/NoFilePanel'
import { useCreateDriveItem } from '@tinycld/drive/lib/upload-to-drive'
import { router } from 'expo-router'
import { LayoutTemplate } from 'lucide-react-native'
import { useCallback, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { TemplatePicker } from '../components/TemplatePicker'
import {
    useCreateBlankTextDocument,
    useCreateTextDocumentFromTemplate,
} from '../hooks/use-text-documents'
import type { TemplateId } from '../lib/templates/index'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const MD_MIME = 'text/markdown'
const TXT_MIME = 'text/plain'

export default function TextIndex() {
    const orgHref = useOrgHref()
    const blank = useCreateBlankTextDocument()
    const template = useCreateTextDocumentFromTemplate()
    const create = useCreateDriveItem()
    const addToast = useToastStore(s => s.addToast)
    const [isPickerOpen, setPickerOpen] = useState(false)

    const goToDoc = useCallback(
        (itemId: string) => {
            router.replace(orgHref('text/[id]', { id: itemId }))
        },
        [orgHref]
    )

    const handleCreateNew = useCallback(() => {
        blank.create(goToDoc)
    }, [blank, goToDoc])

    const handleOpenPicker = useCallback(() => setPickerOpen(true), [])
    const handleClosePicker = useCallback(() => setPickerOpen(false), [])

    const handlePickTemplate = useCallback(
        (id: TemplateId) => {
            setPickerOpen(false)
            // Blank goes through the empty-docx bootstrap so the resulting
            // doc matches what the "New document" CTA produces; only the
            // non-blank ids run the template upload path.
            if (id === 'blank') {
                blank.create(goToDoc)
                return
            }
            template.create(id, goToDoc)
        },
        [blank, template, goToDoc]
    )

    const handleUpload = useCallback(
        (files: File[]) => {
            void handleUploadFiles({
                files,
                createMutation: create.mutateAsync,
                orgHref,
                addToast,
            })
        },
        [create, orgHref, addToast]
    )

    const isBusy = blank.isPending || template.isPending || create.isPending

    return (
        <View className="flex-1">
            <NoFilePanel
                headline="A blank page."
                sublabel="Where the next thought lands."
                newLabel="New document"
                uploadHint=".docx, .md, .txt"
                accept=".docx,.md,.txt,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/plain"
                onCreateNew={handleCreateNew}
                onUpload={handleUpload}
                isPending={isBusy}
            />
            <View className="absolute right-6 top-6">
                <TemplatePickerTrigger onPress={handleOpenPicker} disabled={isBusy} />
            </View>
            <TemplatePicker
                isOpen={isPickerOpen}
                onClose={handleClosePicker}
                onPick={handlePickTemplate}
                isPending={isBusy}
            />
        </View>
    )
}

interface TemplatePickerTriggerProps {
    onPress: () => void
    disabled?: boolean
}

// Opens the four-template picker. Lives outside NoFilePanel because the
// drive component is shared with calc (which has no templates), so the
// entry point is text-owned. Positioned top-right of the screen so it
// stays out of the way of the panel's centered headline + CTA row.
function TemplatePickerTrigger({ onPress, disabled }: TemplatePickerTriggerProps) {
    const foreground = useThemeColor('foreground')
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel="From template…"
            onPress={onPress}
            disabled={disabled}
            className="flex-row items-center gap-2 px-3 py-2 rounded-md border border-border bg-background hover:border-foreground/40 disabled:opacity-50"
        >
            <LayoutTemplate size={16} color={foreground} />
            <Text className="text-sm font-medium text-foreground">From template…</Text>
        </Pressable>
    )
}

interface UploadHandlerArgs {
    files: File[]
    createMutation: ReturnType<typeof useCreateDriveItem>['mutateAsync']
    orgHref: ReturnType<typeof useOrgHref>
    addToast: ReturnType<typeof useToastStore.getState>['addToast']
}

async function handleUploadFiles({
    files,
    createMutation,
    orgHref,
    addToast,
}: UploadHandlerArgs): Promise<void> {
    const single = files.length === 1
    const createdIds: string[] = []
    const failures: string[] = []
    for (const file of files) {
        try {
            const result = await createMutation({
                body: file,
                name: file.name,
                mimeType: mimeForFile(file),
            })
            createdIds.push(result.itemId)
        } catch (err) {
            captureException('text-upload-file', err, { name: file.name })
            failures.push(file.name)
        }
    }

    if (failures.length > 0) {
        addToast({
            title: failures.length === files.length ? 'Upload failed' : 'Some files failed',
            body:
                failures.length === 1
                    ? `${failures[0]} could not be uploaded.`
                    : `${failures.length} files could not be uploaded: ${failures.slice(0, 3).join(', ')}${failures.length > 3 ? '…' : ''}`,
            variant: 'error',
            duration: 8000,
        })
    }

    const [firstId] = createdIds
    if (single && firstId) {
        router.replace(orgHref('text/[id]', { id: firstId }))
        return
    }
    if (createdIds.length > 0) {
        router.replace(orgHref('drive/recent'))
    }
}

export function mimeForFile(file: File): string {
    const explicit = (file.type || '').toLowerCase()
    if (explicit) return explicit
    const name = file.name.toLowerCase()
    if (name.endsWith('.docx')) return DOCX_MIME
    if (name.endsWith('.md') || name.endsWith('.markdown')) return MD_MIME
    if (name.endsWith('.txt')) return TXT_MIME
    return 'application/octet-stream'
}
