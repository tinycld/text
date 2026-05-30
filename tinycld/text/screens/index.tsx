import { captureException } from '@tinycld/core/lib/errors'
import { useOrgHref } from '@tinycld/core/lib/org-routes'
import { useToastStore } from '@tinycld/core/lib/stores/toast-store'
import { useDocumentTitle } from '@tinycld/core/lib/use-document-title'
import { NoFilePanel } from '@tinycld/drive/components/NoFilePanel'
import { useCreateDriveItem } from '@tinycld/drive/lib/upload-to-drive'
import { router } from 'expo-router'
import { useCallback } from 'react'
import { useCreateBlankTextDocument } from '../hooks/use-text-documents'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const MD_MIME = 'text/markdown'
const TXT_MIME = 'text/plain'

export default function TextIndex() {
    useDocumentTitle('Text')
    const orgHref = useOrgHref()
    const blank = useCreateBlankTextDocument()
    const create = useCreateDriveItem()
    const addToast = useToastStore(s => s.addToast)

    const handleCreateNew = useCallback(() => {
        blank.create(itemId => {
            router.replace(orgHref('text/[id]', { id: itemId }))
        })
    }, [blank, orgHref])

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

    return (
        <NoFilePanel
            headline="A blank page."
            sublabel="Where the next thought lands."
            newLabel="New document"
            uploadHint=".docx, .md, .txt"
            accept=".docx,.md,.txt,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/plain"
            onCreateNew={handleCreateNew}
            onUpload={handleUpload}
            isPending={blank.isPending || create.isPending}
        />
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
