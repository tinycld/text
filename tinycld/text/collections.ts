import type { CoreStores } from '@tinycld/core/lib/pocketbase'
import type { Schema } from '@tinycld/core/types/pbSchema'
import type { createCollection } from 'pbtsdb/core'
import { BasicIndex } from 'pbtsdb/core'
import type { TextSchema } from './types'

// Replace (not intersect) the generated entries for text's own collections —
// a plain intersection would merge each overlapping entry field-wise, letting
// a generated `any` absorb any typed override (see drive's collections.ts).
type MergedSchema = Omit<Schema, keyof TextSchema> & TextSchema

export function registerCollections(
    newCollection: ReturnType<typeof createCollection<MergedSchema>>,
    coreStores: CoreStores
) {
    // Hoisted rather than inlined: an inline `collectionOptions` object literal
    // defeats inference of `alwaysExpand` against `relations` in pbtsdb 0.8.0,
    // typing every expand path as `never`. See core/lib/pocketbase.ts, which
    // hoists the same shape as `indexing`.
    const indexing = {
        autoIndex: 'eager' as const,
        defaultIndexType: BasicIndex,
    }

    const text_comments = newCollection('text_comments', {
        omitOnInsert: ['created', 'updated'] as const,
        relations: { author: coreStores.users },
        alwaysExpand: ['author'],
        collectionOptions: indexing,
    })
    return { text_comments }
}
