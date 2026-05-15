/// <reference path="../pb_data/types.d.ts" />

// Initial migration for text. Creates a single `text_items`
// collection matching the shape declared in types.ts / collections.ts.
// Replace or extend this as you build out the package.
//
// Auth rules: every TinyCld collection ships with rules. Without them
// PocketBase falls back to "superusers only" and every insert/select fails
// with "Only superusers can perform this action." The rules below assume an
// org-scoped data model — each row has an `owner` relation pointing at a
// user_org row, and the rule allows access when the calling user owns that
// user_org. This matches the pattern used by @tinycld/contacts and friends.
//
// If your data isn't org-scoped (user-scoped, public, anything else), pick
// the right rule pattern from the docs:
//   https://tinycld.org/docs/tasks/auth-rules

migrate(
    app => {
        const collection = new Collection({
            type: 'base',
            name: 'text_items',
            listRule: 'owner.user = @request.auth.id',
            viewRule: 'owner.user = @request.auth.id',
            createRule: 'owner.user = @request.auth.id',
            updateRule: 'owner.user = @request.auth.id',
            deleteRule: 'owner.user = @request.auth.id',
            fields: [
                {
                    name: 'name',
                    type: 'text',
                    required: true,
                    min: 1,
                    max: 200,
                },
                {
                    name: 'owner',
                    type: 'relation',
                    required: true,
                    collectionId: 'pbc_user_org_01',
                    cascadeDelete: true,
                    maxSelect: 1,
                },
                {
                    name: 'created',
                    type: 'autodate',
                    onCreate: true,
                    onUpdate: false,
                },
                {
                    name: 'updated',
                    type: 'autodate',
                    onCreate: true,
                    onUpdate: true,
                },
            ],
            indexes: [
                'CREATE INDEX `idx_text_items_owner` ON `text_items` (`owner`)',
            ],
        })
        app.save(collection)
    },
    app => {
        const collection = app.findCollectionByNameOrId('text_items')
        app.delete(collection)
    }
)
