import type { UseMutateFunction } from '@tanstack/react-query'
import type { CreateBlankDriveItemInput } from '@tinycld/drive/lib/upload-to-drive'
import { DOCX_MIME_TYPE } from './mime'

export interface CreateBlankTextDocumentDeps {
    mutate: UseMutateFunction<{ itemId: string }, Error, CreateBlankDriveItemInput>
    onCreated: (itemId: string) => void
    captureException: (tag: string, err: unknown) => void
}

// Triggers a blank text-document create and routes consumers to the
// freshly-minted document on success. The row is created with no file — the
// server's blankfile hook attaches a minimal valid .docx skeleton (see
// core/server/blankfile). We use `mutate` (fire-and-forget with callbacks)
// rather than `mutateAsync` so the surrounding call site doesn't need to be
// async and we can guarantee `captureException` runs on every failure path.
export function createBlankTextDocument({
    mutate,
    onCreated,
    captureException,
}: CreateBlankTextDocumentDeps): void {
    mutate(
        {
            name: 'Untitled.docx',
            mimeType: DOCX_MIME_TYPE,
        },
        {
            onSuccess: result => onCreated(result.itemId),
            onError: err => captureException('text.createDoc', err),
        }
    )
}
