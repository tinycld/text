import type { DriveItems, UserOrg } from '@tinycld/core/types/pbSchema'

// One PB row per posted comment / reply. The root of a thread has
// parent_comment empty; replies point at the root. resolved_at lives on
// the root only — replies inherit. author_name is snapshotted at write
// time so a removed user still renders with a name.
//
// comment_id matches the Tiptap mark's `commentId` attribute; the mark
// itself replicates through Yjs's XmlFragment and is the source of
// truth for anchor position. quoted_text snapshots the anchored text
// at insert time, used by the drawer when the anchor is orphaned.
export interface TextComments {
    id: string
    drive_item: string
    comment_id: string
    quoted_text: string
    parent_comment: string
    body: string
    resolved_at: string
    author: string
    author_name: string
    created: string
    updated: string
    // Set when the row is a reply under a suggestion thread (Phase 5);
    // empty for regular anchored comments. The discriminator the
    // useSuggestionDiscussion adapter filters on. Required-string in
    // the generated pbSchema (PB stores absent text as empty string),
    // mirrored here for assignment compatibility with the registry's
    // type-intersection.
    suggestion_id: string
    // Stamped by the server-side cleanup hook when the parent
    // suggestion's Y.Map entry is deleted. Live queries filter on
    // `archived_at = ''`; the row survives for historical surfaces.
    archived_at: string
}

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
