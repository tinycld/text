// createTextDocumentFromTemplate is the from-template analog of
// createBlankTextDocument — same dependency-injection shape, same
// mutate fire-and-forget pattern, same captureException tag so failures
// land in a single bucket. The only difference: the body comes from
// the embedded-bytes template registry instead of an empty Blob.

import type { UseMutateFunction } from '@tanstack/react-query'
import type {
    CreateDriveItemInput,
    CreateDriveItemResult,
} from '@tinycld/drive/lib/upload-to-drive'
import { DOCX_MIME_TYPE } from './mime'
import { getTemplate, type TemplateId } from './templates/index'
import { loadTemplateBody } from './templates/load-template'

export interface CreateTextDocumentFromTemplateDeps {
    templateId: TemplateId
    mutate: UseMutateFunction<CreateDriveItemResult, Error, CreateDriveItemInput>
    onCreated: (itemId: string) => void
    captureException: (tag: string, err: unknown) => void
}

// We separate the bytes-load failure path from the mutate failure path
// so a corrupt generated.ts (bad base64, missing id) is reported with
// the same tag and the call site doesn't have to thread a try/catch
// just to handle a programmer error. The body load is async because the
// native path writes a temp file (web resolves synchronously); we await
// it before mutate so a load failure never reaches the mutation.
export async function createTextDocumentFromTemplate({
    templateId,
    mutate,
    onCreated,
    captureException,
}: CreateTextDocumentFromTemplateDeps): Promise<void> {
    let body: CreateDriveItemInput['body']
    let name: string
    try {
        body = await loadTemplateBody(templateId)
        name = getTemplate(templateId).fileName
    } catch (err) {
        captureException('text.createDocFromTemplate', err)
        return
    }
    mutate(
        { body, name, mimeType: DOCX_MIME_TYPE },
        {
            onSuccess: result => onCreated(result.itemId),
            onError: err => captureException('text.createDocFromTemplate', err),
        }
    )
}
