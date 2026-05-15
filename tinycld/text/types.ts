// Schema types for this package, merged into core's MergedSchema by the
// generator. Each entry maps a pbtsdb collection name to its record type
// and optional relations. Rename, replace, or delete text_items
// when you wire up your first real collection.

export interface TextItem {
    id: string
    name: string
    owner: string
    created: string
    updated: string
}

export type TextSchema = {
    text_items: {
        type: TextItem
    }
}
