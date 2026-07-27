/// <reference path="../../tinycld/server/pb_data/types.d.ts" />
// Two corrections to text_comments' access rules.
//
// 1. EXCLUDE SUSPENDED USERS.
//    No text_comments rule carries `@request.auth.disabled != true`, and the
//    Go gate (core/driveshare) never runs for /api/collections/*_comments —
//    PocketBase evaluates these rules instead. So a disabled user whose
//    drive_shares rows survive their suspension can still list, view AND
//    create comments over plain REST. Suspension has to hold on every path
//    that reads the data, not just the ones written in Go.
//
// 2. HONOUR THE DOCUMENT'S CREATOR.
//    Every drive_items rule reads `created_by ?= @request.auth.id ||
//    <has-share>`, because drive's owner-share hook can be bypassed by a
//    direct SDK write and historically was — a creator with no share row of
//    their own is a state the system actually reaches. These rules kept only
//    the share half, so such a creator could open and edit their own document
//    while seeing zero comments on it and being unable to post one.
//
// A commentor must still be able to comment: that is the entire role. The
// share predicate here is deliberately membership-only (`user ?= auth.id`),
// with no role test, so commentor/editor/owner all keep create — while
// drive_items' own update rule (migration 1782100000) is what stops a
// commentor editing the document itself.
migrate(
    app => {
        const enabled = '@request.auth.disabled != true'
        const authed = '@request.auth.id != ""'
        const isDocCreator = 'drive_item.created_by ?= @request.auth.id'
        const hasShare = 'drive_item.drive_shares_via_item.user ?= @request.auth.id'
        const reachesDoc = `(${isDocCreator} || ${hasShare})`
        const isAuthor = 'author = @request.auth.id'

        const col = app.findCollectionByNameOrId('text_comments')
        col.listRule = `${authed} && ${enabled} && ${reachesDoc}`
        col.viewRule = `${authed} && ${enabled} && ${reachesDoc}`
        col.createRule = `${authed} && ${enabled} && ${reachesDoc} && ${isAuthor}`
        col.updateRule = `${authed} && ${enabled} && ${isAuthor}`
        col.deleteRule = `${authed} && ${enabled} && ${isAuthor}`
        app.save(col)
    },
    app => {
        // Restore 1720000000's rules verbatim, both gaps included.
        const col = app.findCollectionByNameOrId('text_comments')
        col.listRule =
            '@request.auth.id != "" && drive_item.drive_shares_via_item.user ?= @request.auth.id'
        col.viewRule =
            '@request.auth.id != "" && drive_item.drive_shares_via_item.user ?= @request.auth.id'
        col.createRule =
            '@request.auth.id != "" && drive_item.drive_shares_via_item.user ?= @request.auth.id && author = @request.auth.id'
        col.updateRule = '@request.auth.id != "" && author = @request.auth.id'
        col.deleteRule = '@request.auth.id != "" && author = @request.auth.id'
        app.save(col)
    }
)
