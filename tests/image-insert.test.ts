// handleImageInsert orchestrates the image picker + Tiptap insertion. The
// React component delegates to it so the surface area we care about — "did
// the picker error path route through captureException, and did cancellation
// stay silent" — can be unit tested without mounting React Native primitives.
//
// Same testing approach as use-print-document.test.tsx.

import { describe, expect, it, vi } from 'vitest'
import { handleImageInsert } from '../tinycld/text/components/ImageInsertButton'

function makeDeps(overrides: {
    pickImageAsDataUri?: () => Promise<string | null>
}) {
    return {
        pickImageAsDataUri:
            overrides.pickImageAsDataUri ?? (() => Promise.resolve('data:image/png;base64,AAA')),
        captureException: vi.fn(),
    }
}

describe('handleImageInsert', () => {
    it('forwards the picked data URI to onInsert on success', async () => {
        const onInsert = vi.fn()
        const deps = makeDeps({
            pickImageAsDataUri: () => Promise.resolve('data:image/png;base64,XYZ'),
        })
        await handleImageInsert(onInsert, deps)
        expect(onInsert).toHaveBeenCalledWith('data:image/png;base64,XYZ')
        expect(deps.captureException).not.toHaveBeenCalled()
    })

    it('treats a null picker result as user cancellation (no onInsert, no captureException)', async () => {
        const onInsert = vi.fn()
        const deps = makeDeps({ pickImageAsDataUri: () => Promise.resolve(null) })
        await handleImageInsert(onInsert, deps)
        expect(onInsert).not.toHaveBeenCalled()
        expect(deps.captureException).not.toHaveBeenCalled()
    })

    it('reports picker failures via captureException with the text.imageInsert tag', async () => {
        const boom = new Error('picker exploded')
        const onInsert = vi.fn()
        const deps = makeDeps({
            pickImageAsDataUri: () => Promise.reject(boom),
        })
        await expect(handleImageInsert(onInsert, deps)).resolves.toBeUndefined()
        expect(onInsert).not.toHaveBeenCalled()
        expect(deps.captureException).toHaveBeenCalledTimes(1)
        const [tag, err] = deps.captureException.mock.calls[0]
        expect(tag).toBe('text.imageInsert')
        expect(err).toBe(boom)
    })
})
