import { create } from '@tinycld/core/lib/store'

export interface ReviewDrawerState {
    isOpen: boolean
    driveItemId: string | null
    focusedSuggestionId: string | null
    open: (driveItemId: string) => void
    close: () => void
    focusSuggestion: (id: string | null) => void
}

// createReviewDrawerStore mirrors the comments-drawer pattern in
// @tinycld/core/lib/stores/comments-drawer-store, scoped to suggestion
// review. The drawer is one-per-document: opening for a different
// driveItemId clears the focused-suggestion state so a stale anchor
// from doc A doesn't try to focus in doc B.
//
// Factory (not singleton hook) for the same reason editor-mode-store
// is a factory — the screen scope owns one instance per open document
// so back-stack navigation across documents doesn't leak state.
export function createReviewDrawerStore() {
    return create<ReviewDrawerState>(set => ({
        isOpen: false,
        driveItemId: null,
        focusedSuggestionId: null,
        open: driveItemId =>
            set(s => ({
                isOpen: true,
                driveItemId,
                // If we're switching documents, drop the focused
                // suggestion from the previous doc.
                focusedSuggestionId: s.driveItemId === driveItemId ? s.focusedSuggestionId : null,
            })),
        close: () => set({ isOpen: false, focusedSuggestionId: null }),
        focusSuggestion: id => set({ focusedSuggestionId: id }),
    }))
}

export type ReviewDrawerStore = ReturnType<typeof createReviewDrawerStore>
