import type { DriveItems, TextComments, UserOrg } from '@tinycld/core/types/pbSchema'

// TextComments is generated from PocketBase schema on every migration
// (see core/types/pbSchema.ts — the source of truth). Re-exported here
// so existing call sites can keep importing from '~/types' without
// chasing the alias. The shape and field comments live in the
// generator's documentation; consult pbSchema.ts for the canonical
// declaration.
export type { TextComments }

export type TextSchema = {
    text_comments: {
        type: TextComments
        relations: {
            drive_item: DriveItems
            parent_comment?: TextComments
            author: UserOrg
        }
    }
}
