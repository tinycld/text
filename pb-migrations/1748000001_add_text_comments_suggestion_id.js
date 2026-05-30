/// <reference path="../../../server/pb_data/types.d.ts" />
migrate(
    app => {
        const textComments = app.findCollectionByNameOrId('text_comments')

        // suggestion_id: foreign-key (by string) to the Y.Map suggestion
        // entry this reply belongs to. Discriminator for the
        // SuggestionDiscussion adapter — when set, the row is a reply
        // under a suggestion thread; when null, the row is a regular
        // anchored comment keyed by `comment_id`. Existing rows leave
        // it null and continue to render in the comments drawer.
        textComments.fields.add(
            new Field({
                id: 'tc_suggestion_id',
                name: 'suggestion_id',
                type: 'text',
                required: false,
                max: 64,
            })
        )

        // archived_at: stamped by a future server-side hook when the
        // parent suggestion's Y.Map entry is deleted. Soft-delete: the
        // row stays in the table so historical activity (resolved-with-
        // discussion views) can still surface it, but live queries
        // filter on archived_at = null.
        textComments.fields.add(
            new Field({
                id: 'tc_archived_at',
                name: 'archived_at',
                type: 'date',
                required: false,
            })
        )

        textComments.indexes = [
            'CREATE INDEX `idx_text_comments_anchor` ON `text_comments` (`drive_item`, `comment_id`)',
            'CREATE INDEX `idx_text_comments_unresolved` ON `text_comments` (`drive_item`, `resolved_at`)',
            'CREATE INDEX `idx_text_comments_author` ON `text_comments` (`author`)',
            'CREATE INDEX `idx_text_comments_parent` ON `text_comments` (`parent_comment`)',
            'CREATE INDEX `idx_text_comments_suggestion` ON `text_comments` (`suggestion_id`)',
        ]

        app.save(textComments)
    },
    app => {
        const textComments = app.findCollectionByNameOrId('text_comments')
        textComments.fields.removeById('tc_suggestion_id')
        textComments.fields.removeById('tc_archived_at')
        textComments.indexes = [
            'CREATE INDEX `idx_text_comments_anchor` ON `text_comments` (`drive_item`, `comment_id`)',
            'CREATE INDEX `idx_text_comments_unresolved` ON `text_comments` (`drive_item`, `resolved_at`)',
            'CREATE INDEX `idx_text_comments_author` ON `text_comments` (`author`)',
            'CREATE INDEX `idx_text_comments_parent` ON `text_comments` (`parent_comment`)',
        ]
        app.save(textComments)
    }
)
