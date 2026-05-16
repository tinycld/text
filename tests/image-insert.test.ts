// handleImageInsert orchestrates the image picker + drive upload + onInsert
// callback. The React surfaces (toolbar's ImageInsertButton, menubar's
// Insert > Image) both delegate to it through the useImageInsert hook so
// the test focuses on the bytes-flow: did the picker hand off to the
// drive uploader, did onInsert receive the resulting URL, and did the
// error paths (picker reject, upload reject, user cancel) behave like
// Google Docs / Word would.

import { describe, expect, it, vi } from 'vitest'
import {
    handleImageInsert,
    type PickedImage,
    type UploadMutate,
} from '../tinycld/text/components/image-insert-handler'

function pickedPng(name = 'photo.png'): PickedImage {
    // The drive uploader only inspects `body`, `name`, and `mimeType`.
    // Hand it a duck-typed Blob — under node the real Blob constructor
    // also works, but a literal keeps the test independent of node
    // version quirks.
    return {
        body: { size: 4, type: 'image/png' } as unknown as Blob,
        name,
        mimeType: 'image/png',
    }
}

interface FakeDriveItem {
    itemId: string
    finalName: string
    parentId: string
}

function makeDeps(overrides: {
    pickImage?: () => Promise<PickedImage | null>
    upload?: UploadMutate
    getURL?: (collectionId: string, itemId: string, finalName: string) => string
}) {
    const defaultResult: FakeDriveItem = {
        itemId: 'rec_123',
        finalName: 'photo.png',
        parentId: '',
    }
    const defaultUpload: UploadMutate = (_input, { onSuccess }) => onSuccess(defaultResult)
    return {
        pickImage: overrides.pickImage ?? (() => Promise.resolve(pickedPng())),
        upload: overrides.upload ?? defaultUpload,
        getURL:
            overrides.getURL ??
            ((collectionId, itemId, finalName) =>
                `/api/files/${collectionId}/${itemId}/${finalName}`),
        captureException: vi.fn(),
    }
}

describe('handleImageInsert', () => {
    it('uploads the picked image to drive and inserts the resulting URL', async () => {
        const onInsert = vi.fn()
        const upload: UploadMutate = vi.fn((_input, { onSuccess }) =>
            onSuccess({ itemId: 'rec_abc', finalName: 'kept.png', parentId: '' })
        )
        const deps = makeDeps({
            pickImage: () => Promise.resolve(pickedPng('kept.png')),
            upload,
        })
        await handleImageInsert(onInsert, deps)
        expect(upload).toHaveBeenCalledTimes(1)
        const [input] = (upload as ReturnType<typeof vi.fn>).mock.calls[0]
        expect(input).toMatchObject({ name: 'kept.png', mimeType: 'image/png' })
        expect(onInsert).toHaveBeenCalledWith('/api/files/drive_items/rec_abc/kept.png')
        expect(deps.captureException).not.toHaveBeenCalled()
    })

    it('treats a null picker result as user cancellation (no upload, no onInsert, no captureException)', async () => {
        const onInsert = vi.fn()
        const upload: UploadMutate = vi.fn()
        const deps = makeDeps({ pickImage: () => Promise.resolve(null), upload })
        await handleImageInsert(onInsert, deps)
        expect(upload).not.toHaveBeenCalled()
        expect(onInsert).not.toHaveBeenCalled()
        expect(deps.captureException).not.toHaveBeenCalled()
    })

    it('reports picker failures via captureException with the text.toolbarImageUpload tag', async () => {
        const boom = new Error('picker exploded')
        const onInsert = vi.fn()
        const upload: UploadMutate = vi.fn()
        const deps = makeDeps({
            pickImage: () => Promise.reject(boom),
            upload,
        })
        await expect(handleImageInsert(onInsert, deps)).resolves.toBeUndefined()
        expect(upload).not.toHaveBeenCalled()
        expect(onInsert).not.toHaveBeenCalled()
        expect(deps.captureException).toHaveBeenCalledTimes(1)
        const [tag, err] = deps.captureException.mock.calls[0]
        expect(tag).toBe('text.toolbarImageUpload')
        expect(err).toBe(boom)
    })

    it('reports drive upload failures via captureException and never inserts a URL', async () => {
        const boom = new Error('drive offline')
        const onInsert = vi.fn()
        const upload: UploadMutate = vi.fn((_input, { onError }) => onError(boom))
        const deps = makeDeps({ upload })
        await handleImageInsert(onInsert, deps)
        expect(onInsert).not.toHaveBeenCalled()
        expect(deps.captureException).toHaveBeenCalledTimes(1)
        const [tag, err] = deps.captureException.mock.calls[0]
        expect(tag).toBe('text.toolbarImageUpload')
        expect(err).toBe(boom)
    })

    it('forwards the picked body / name / mimeType to the drive uploader unchanged', async () => {
        const onInsert = vi.fn()
        const upload: UploadMutate = vi.fn((_input, { onSuccess }) =>
            onSuccess({ itemId: 'x', finalName: 'x', parentId: '' })
        )
        const body = { size: 99, type: 'image/jpeg' } as unknown as Blob
        const deps = makeDeps({
            pickImage: () =>
                Promise.resolve({ body, name: 'scan.jpg', mimeType: 'image/jpeg' }),
            upload,
        })
        await handleImageInsert(onInsert, deps)
        const [input] = (upload as ReturnType<typeof vi.fn>).mock.calls[0]
        expect(input.body).toBe(body)
        expect(input.name).toBe('scan.jpg')
        expect(input.mimeType).toBe('image/jpeg')
    })
})
