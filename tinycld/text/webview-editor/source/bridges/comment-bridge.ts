import type { Editor } from '@tiptap/react'
import { snapshotCommentIds } from '../../../lib/editor/comment-mark'

// Comment bridge for the text WebView. Owns the namespace='comment'
// half of the message-bus protocol declared in
// @tinycld/core/lib/editor/message-bus/types.ts:
//
//   host → WebView
//     comment.add               { commentId } — apply mark to current selection
//     comment.remove            { commentId } — strip all ranges with this id
//     comment.selection-request { requestId } — reply with current selection
//
//   WebView → host
//     comment.tap                { commentId }                         — user clicked a marked range
//     comment.removed            { commentIds: string[] }              — marks disappeared via edits
//     comment.selection-response { requestId, range | null }           — reply to selection-request
//
// onTransaction diffs the commentId set before/after each transaction
// and emits `comment.removed` when a mark vanishes (the user deleted
// the underlying text, or an undo wiped the mark). The host treats
// "removed" as the orphan signal — the PB row stays, the drawer just
// shows "anchor removed".

interface BridgeMessage<P = unknown> {
    namespace: 'comment'
    type: string
    requestId?: string
    payload: P
}

interface IncomingMessage {
    namespace?: string
    type?: string
    requestId?: string
    payload?: unknown
}

type PostToNative = (message: unknown) => void

export interface CommentBridge {
    destroy: () => void
}

export function installCommentBridge(editor: Editor, postToNative: PostToNative): CommentBridge {
    let lastIds = snapshotCommentIds(editor.state.doc)

    function send<P>(type: string, payload: P, requestId?: string): void {
        const message: BridgeMessage<P> = requestId
            ? { namespace: 'comment', type, requestId, payload }
            : { namespace: 'comment', type, payload }
        postToNative(message)
    }

    function onTransaction(): void {
        const nextIds = snapshotCommentIds(editor.state.doc)
        const removed: string[] = []
        for (const id of lastIds) {
            if (!nextIds.has(id)) removed.push(id)
        }
        lastIds = nextIds
        if (removed.length > 0) {
            send('removed', { commentIds: removed })
        }
    }

    function onDomClick(evt: Event): void {
        const target = evt.target
        if (!(target instanceof Element)) return
        // Walk up to a .tinycld-comment span carrying data-comment-id.
        // The mark wraps its range as <span class="tinycld-comment"
        // data-comment-id="…">…</span>; nested marks (bold inside a
        // comment) shift the click target to the inner element.
        const marked = target.closest('span[data-comment-id]')
        if (!marked) return
        const commentId = marked.getAttribute('data-comment-id')
        if (!commentId) return
        send('tap', { commentId })
    }

    function onMessage(evt: MessageEvent): void {
        if (typeof evt.data !== 'string') return
        let parsed: IncomingMessage
        try {
            parsed = JSON.parse(evt.data) as IncomingMessage
        } catch {
            return
        }
        if (parsed.namespace !== 'comment' || !parsed.type) return
        switch (parsed.type) {
            case 'add': {
                const { commentId } = (parsed.payload ?? {}) as { commentId?: string }
                if (!commentId) return
                editor.chain().focus().addComment(commentId).run()
                return
            }
            case 'remove': {
                const { commentId } = (parsed.payload ?? {}) as { commentId?: string }
                if (!commentId) return
                editor.chain().removeComment(commentId).run()
                return
            }
            case 'selection-request': {
                const { requestId } = parsed
                if (!requestId) return
                const sel = editor.state.selection
                const range = sel.empty ? null : { from: sel.from, to: sel.to }
                send('selection-response', { range }, requestId)
                return
            }
        }
    }

    editor.on('transaction', onTransaction)
    editor.view.dom.addEventListener('click', onDomClick)
    window.addEventListener('message', onMessage)
    document.addEventListener('message', onMessage as EventListener)

    return {
        destroy: () => {
            editor.off('transaction', onTransaction)
            editor.view.dom.removeEventListener('click', onDomClick)
            window.removeEventListener('message', onMessage)
            document.removeEventListener('message', onMessage as EventListener)
        },
    }
}
