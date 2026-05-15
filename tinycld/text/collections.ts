import type { CoreStores } from '@tinycld/core/lib/pocketbase'
import type { Schema } from '@tinycld/core/types/pbSchema'
import type { createCollection } from 'pbtsdb/core'
import { BasicIndex } from 'pbtsdb/core'
import type { TextSchema } from './types'

type MergedSchema = Schema & TextSchema

// Collections contributed by this package. Core calls this during pbtsdb
// bootstrap; the returned object's keys become top-level keys on the app's
// MergedSchema (accessible via `useStore('...')`).
export function registerCollections(
    newCollection: ReturnType<typeof createCollection<MergedSchema>>,
    _core: CoreStores
) {
    const text_items = newCollection('text_items', {
        omitOnInsert: ['created', 'updated'] as const,
        collectionOptions: {
            autoIndex: 'eager' as const,
            defaultIndexType: BasicIndex,
        },
    })

    return {
        text_items,
    }
}
