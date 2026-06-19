// Web materialization of a template's embedded base64 bytes. The
// browser's Blob constructor accepts an ArrayBuffer part, so we decode
// to bytes and hand back a real Blob — the same content-type the blank
// flow produces, which useCreateDriveItem uploads as a FormData file.
//
// Native uses load-template.native.ts instead: React Native's Blob
// implementation rejects ArrayBuffer/ArrayBufferView parts, so there we
// write a temp file and upload by URI. Metro/Vitest pick the right file
// by the .web/.native suffix; both export the same loadTemplateBody.

import type { UploadBody } from '@tinycld/drive/lib/upload-to-drive'
import { DOCX_MIME_TYPE } from '../mime'
import { getTemplateBase64, type TemplateId } from './index'

export function loadTemplateBody(id: TemplateId): UploadBody {
    const b64 = getTemplateBase64(id)
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i)
    }
    // Slice into a fresh ArrayBuffer for TS's strict SharedArrayBuffer
    // narrowing on the Blob constructor — mirrors calc/lib/blank-workbook.
    const ab = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer
    return new Blob([ab], { type: DOCX_MIME_TYPE })
}
