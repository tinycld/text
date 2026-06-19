// Native materialization of a template's embedded base64 bytes. React
// Native's Blob implementation throws "Creating blobs from 'ArrayBuffer'
// and 'ArrayBufferView' are not supported" (BlobManager.createFromParts),
// so we can't hand useCreateDriveItem an in-memory Blob the way web does.
// Instead we write the base64 straight to a cache-directory file (no
// decode needed — expo-file-system writes base64 natively) and return
// the documented native UploadBody shape `{ uri, name, type }`, which
// RN's FormData polyfill turns into the multipart file part.

import type { UploadBody } from '@tinycld/drive/lib/upload-to-drive'
import * as FileSystem from 'expo-file-system'
import { DOCX_MIME_TYPE } from '../mime'
import { getTemplate, getTemplateBase64, type TemplateId } from './index'

// Cast through unknown — the legacy/modern split in expo-file-system
// surfaces slightly different field shapes per release (mirrors the
// pattern in calc/lib/csv/download.native.ts).
const fileSystem = FileSystem as unknown as {
    cacheDirectory?: string | null
    documentDirectory?: string | null
    writeAsStringAsync: (
        uri: string,
        contents: string,
        options?: { encoding?: string }
    ) => Promise<void>
    EncodingType?: { Base64?: string }
}

// Monotonic per-session counter so two rapid creates can't race on the
// same temp path. RN reads the file lazily during the upload request, so
// reusing a path while a prior upload is still in flight could ship the
// wrong bytes; a fresh suffix each call avoids that.
let writeSeq = 0

export async function loadTemplateBody(id: TemplateId): Promise<UploadBody> {
    const b64 = getTemplateBase64(id)
    const { fileName } = getTemplate(id)
    const dir = fileSystem.cacheDirectory ?? fileSystem.documentDirectory
    if (dir == null) {
        throw new Error('loadTemplateBody: no writable directory available')
    }
    const safeName = fileName.replace(/[/\\]/g, '_')
    const uri = `${dir}template-${id}-${writeSeq++}-${safeName}`
    await fileSystem.writeAsStringAsync(uri, b64, {
        encoding: fileSystem.EncodingType?.Base64 ?? 'base64',
    })
    return { uri, name: fileName, type: DOCX_MIME_TYPE }
}
