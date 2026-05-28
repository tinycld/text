/// <reference path="../../../server/pb_data/types.d.ts" />
migrate(
    app => {
        const versions = app.findCollectionByNameOrId('drive_item_versions')

        // yjs_state: full Yjs state encoded via Y.encodeStateAsUpdateV2
        // at version-save time. Authoritative snapshot for restoring
        // a version with full suggestion and authorship fidelity. The
        // docx blob in `file` remains the human-readable form.
        versions.fields.add(
            new Field({
                id: 'drv_ver_yjs_state',
                name: 'yjs_state',
                type: 'file',
                required: false,
                maxSelect: 1,
                maxSize: 50 * 1024 * 1024, // 50 MiB — Yjs state is compact, but cap matches docx
            })
        )

        // version_metadata: JSON describing the snapshot's contributors,
        // open-suggestion count, and the doc schema version. Used by
        // the version browser to render contributor avatars and the
        // open-suggestions badge without loading the snapshot.
        // Shape:
        //   { suggestionsOpen: number, authors: string[], schemaVersion: number }
        versions.fields.add(
            new Field({
                id: 'drv_ver_metadata',
                name: 'version_metadata',
                type: 'json',
                required: false,
                maxSize: 100 * 1024,
            })
        )

        app.save(versions)
    },
    app => {
        const versions = app.findCollectionByNameOrId('drive_item_versions')
        versions.fields.removeById('drv_ver_yjs_state')
        versions.fields.removeById('drv_ver_metadata')
        app.save(versions)
    }
)
