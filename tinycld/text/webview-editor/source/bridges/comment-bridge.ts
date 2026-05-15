// Comment bridge — v1 stub. Reserves the 'comment' message-bus
// namespace so v1.1's full implementation slots in without protocol
// versioning. Currently a no-op.
//
// ---
//
// v1.1 implementation shape:
//
// Inside the WebView (Editor.tsx):
//
//   - Register a Comment TipTap mark with a `commentId` string
//     attribute and a click handler that posts
//     `{namespace: 'comment', type: 'tap', payload: {commentId}}` to
//     native.
//   - Register a ProseMirror decoration plugin that paints commented
//     ranges with a subtle highlight (yellow background, or an
//     underline). The plugin iterates the editor state's marks on
//     every transaction; cheap because marks are sparse.
//   - Add a message-bus listener for incoming `{namespace: 'comment'}`
//     messages from native:
//       * `comment.add` { commentId } — apply the Comment mark to the
//         current selection range. Caller responsible for picking the
//         range before calling.
//       * `comment.remove` { commentId } — strip the Comment mark
//         from any range carrying that ID.
//       * `comment.selection-request` { requestId } — reply with the
//         current selection range so native can prompt for comment
//         text positioned correctly.
//   - ProseMirror's mark-tracking handles anchor migration through
//     concurrent edits automatically. This is the hardest correctness
//     property of comments and we get it for free.
//
// Outside the WebView (in text/ — NOT core):
//
//   - A new `<CommentSidebar />` component reads a Y.Map of thread
//     state and renders the list of comments + thread replies. The
//     Y.Map lives in the same Y.Doc as the document content, so
//     concurrent edits to threads converge automatically via Yjs.
//   - A `useComments(yDoc)` hook exposes thread CRUD. Mutations are
//     plain Y.Map updates; reads are reactive via
//     yMap.observe(callback) → React state.
//   - A `<CommentTrigger />` floating button (visible when a multi-
//     character selection exists) opens a prompt for the new
//     comment's text. On submit:
//       1. Generate a UUID for the thread.
//       2. Insert the thread record into the Y.Map.
//       3. Post `{namespace: 'comment', type: 'add', payload:
//          {commentId}}` to the WebView so the Comment mark gets
//          applied to the selection.
//
// Effort estimate (from the planning conversation):
//   - Add/highlight/thread sidebar: ~2-3 weeks
//   - @mentions, unread state, resolve UI: ~1-2 weeks
//
// No exports yet — Phase 4's Editor.tsx doesn't import this file. The
// presence of this file documents the reserved namespace and the
// architectural shape so the v1.1 work doesn't need to re-litigate
// either.

export const COMMENT_BRIDGE_VERSION = 'v1-stub' as const
