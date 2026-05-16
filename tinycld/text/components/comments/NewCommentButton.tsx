import { useCommentsDrawerStore } from '@tinycld/core/lib/stores/comments-drawer-store'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { CommentComposer } from '@tinycld/core/ui/comments'
import { MessageSquarePlus } from 'lucide-react-native'
import { newRecordId } from 'pbtsdb/core'
import { useState } from 'react'
import { Modal, Platform, Pressable, Text, View } from 'react-native'
import { useCommentMutations } from '../../hooks/use-comment-mutations'
import type { DocumentCommentBridge } from '../../hooks/use-document-editor'

export interface NewCommentButtonProps {
    driveItemId: string
    commentBridge: DocumentCommentBridge | null
    // True when the editor has no active selection — the button must
    // be inert because creating a comment without a range to anchor
    // it produces an immediately-orphaned thread.
    selectionEmpty: boolean
    disabled?: boolean
}

// Toolbar button that starts a new comment thread on the current
// editor selection. Opens a centered Modal composer (matches the
// pattern in LinkPopover — proper popover positioning is platform-
// dependent and not worth the v1 cost). On submit, generates a
// commentId, applies the mark to the captured range, and inserts
// the root row. The drawer focuses the new thread so the user sees
// it appear without manually opening Comments.
export function NewCommentButton({
    driveItemId,
    commentBridge,
    selectionEmpty,
    disabled = false,
}: NewCommentButtonProps) {
    const [pendingRange, setPendingRange] = useState<{ from: number; to: number } | null>(null)

    const { add } = useCommentMutations()
    const openDrawer = useCommentsDrawerStore(s => s.open)
    const iconColor = useThemeColor('muted-foreground')
    const activeColor = useThemeColor('primary')

    const isDisabled = disabled || selectionEmpty || !commentBridge

    const onTrigger = () => {
        if (isDisabled || !commentBridge) return
        const range = commentBridge.getSelection()
        if (!range) return
        setPendingRange(range)
    }

    const onCancel = () => {
        setPendingRange(null)
    }

    const onSubmit = (body: string) => {
        if (!commentBridge || !pendingRange) return
        const commentId = newRecordId()
        // Apply the mark first — passing the captured pendingRange so
        // the selection survives the modal's focus theft (the user's
        // visible selection on the page is gone by now). The PB row
        // lands second; on failure we strip the mark so we don't leave
        // a phantom underline with no thread behind it.
        commentBridge.addComment(commentId, pendingRange)
        add.mutate(
            {
                driveItemId,
                commentId,
                quotedText: '',
                body,
            },
            {
                onSuccess: () => {
                    openDrawer({ packageSlug: 'text', driveItemId })
                    setPendingRange(null)
                },
                onError: () => {
                    // PB rule rejection / network blip — roll back the
                    // mark so the doc doesn't accumulate orphaned
                    // marks for failed inserts. The composer stays
                    // open with the error surfaced by `add.error` so
                    // the user can retry without re-selecting.
                    commentBridge.removeComment(commentId)
                },
            }
        )
    }

    const webProps =
        Platform.OS === 'web'
            ? { onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault() }
            : {}

    const isOpen = pendingRange != null

    return (
        <>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel="New comment"
                accessibilityState={{ disabled: isDisabled }}
                disabled={isDisabled}
                onPress={onTrigger}
                {...webProps}
                className="rounded-md p-1.5"
                style={{ opacity: isDisabled ? 0.4 : 1 }}
                hitSlop={
                    Platform.OS === 'web'
                        ? undefined
                        : { top: 6, bottom: 6, left: 4, right: 4 }
                }
            >
                <MessageSquarePlus size={16} color={isOpen ? activeColor : iconColor} />
            </Pressable>
            <NewCommentModal
                isOpen={isOpen}
                isPending={add.isPending}
                error={add.error ? String(add.error.message ?? add.error) : null}
                onCancel={onCancel}
                onSubmit={onSubmit}
            />
        </>
    )
}

interface NewCommentModalProps {
    isOpen: boolean
    isPending: boolean
    error: string | null
    onCancel: () => void
    onSubmit: (body: string) => void
}

function NewCommentModal({ isOpen, isPending, error, onCancel, onSubmit }: NewCommentModalProps) {
    if (!isOpen) return null
    return (
        <Modal transparent animationType="fade" visible={isOpen} onRequestClose={onCancel}>
            <Pressable
                className="flex-1 items-center justify-center bg-black/30"
                onPress={onCancel}
            >
                <Pressable
                    onPress={e => e.stopPropagation?.()}
                    className="bg-background rounded-md p-4 min-w-[320px] max-w-[480px] border border-border"
                >
                    <Text className="text-sm font-semibold text-foreground mb-2">New comment</Text>
                    <CommentComposer
                        placeholder="Add a comment…"
                        submitLabel="Comment"
                        isPending={isPending}
                        error={error}
                        autoFocus
                        onCancel={onCancel}
                        onSubmit={onSubmit}
                    />
                </Pressable>
            </Pressable>
        </Modal>
    )
}
