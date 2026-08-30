import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type PocketBase from 'pocketbase'
import { DOCX_MIME_TYPE } from './lib/mime'

interface SeedContext {
    user: { id: string; email: string; name: string }
}

function log(...args: unknown[]) {
    process.stdout.write(`[seed:text] ${args.join(' ')}\n`)
}

const FIXTURE_PATH = path.resolve(
    import.meta.dirname,
    '..',
    '..',
    'tests',
    'assets',
    'feature-test.docx'
)

export default async function seed(pb: PocketBase, ctx: SeedContext): Promise<void> {
    const { user } = ctx
    const fileName = 'Feature Test.docx'

    // Scoped to this user: a name-only match skips seeding whenever ANY account
    // has a file by this name, so after a user-scoped demo reset the sample
    // never comes back.
    const existing = await pb.collection('drive_items').getList(1, 1, {
        filter: pb.filter('name = {:name} && created_by = {:uid}', {
            name: fileName,
            uid: user.id,
        }),
    })
    if (existing.items.length > 0) {
        log(`Skipping (already seeded): ${fileName}`)
        return
    }

    const buffer = await readFile(FIXTURE_PATH)
    const blob = new Blob([buffer], { type: DOCX_MIME_TYPE })
    log(`Uploading sample document: ${fileName} (${buffer.byteLength} bytes)`)

    const formData = new FormData()
    formData.append('name', fileName)
    formData.append('is_folder', 'false')
    formData.append('mime_type', DOCX_MIME_TYPE)
    formData.append('parent', '')
    formData.append('created_by', user.id)
    formData.append('size', String(buffer.byteLength))
    formData.append('description', '')
    formData.append('file', blob, fileName)
    await pb.collection('drive_items').create(formData)
}
