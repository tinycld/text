import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { FileDiff } from 'lucide-react-native'
import { Platform, Pressable } from 'react-native'
import { useStore } from 'zustand'
import type { ReviewDrawerStore } from '../../stores/review-drawer-store'

export interface OpenReviewDrawerButtonProps {
    driveItemId: string
    store: ReviewDrawerStore
    disabled?: boolean
}

// OpenReviewDrawerButton lives in the toolbar. Tapping it toggles the
// review drawer for the current document. Lucide's FileDiff icon
// visually communicates "this is about changes to the document"
// without leaning on Comments-style speech-bubble iconography.
//
// Mirrors OpenCommentsDrawerButton's shape but takes the store as a
// prop because the review drawer is per-document (factory store) while
// the comments drawer is a singleton.
export function OpenReviewDrawerButton({
    driveItemId,
    store,
    disabled = false,
}: OpenReviewDrawerButtonProps) {
    const isOpen = useStore(store, s => s.isOpen)
    const storeDriveItemId = useStore(store, s => s.driveItemId)
    const iconColor = useThemeColor('muted-foreground')
    const activeColor = useThemeColor('primary')

    const drawerIsOpen = isOpen && storeDriveItemId === driveItemId
    const color = drawerIsOpen ? activeColor : iconColor
    const backgroundColor = drawerIsOpen ? `${activeColor}22` : undefined

    const onPress = () => {
        const state = store.getState()
        if (drawerIsOpen) {
            state.close()
        } else {
            state.open(driveItemId)
        }
    }

    // ProseMirror loses its selection on focus blur, which would make
    // the toolbar click steal focus from the editor. Match the rest of
    // DocumentToolbar's mousedown-suppression to keep the caret stable.
    const webProps =
        Platform.OS === 'web'
            ? { onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault() }
            : {}

    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open suggestion review drawer"
            accessibilityState={{ disabled, selected: drawerIsOpen }}
            disabled={disabled}
            onPress={onPress}
            {...webProps}
            className="rounded-md p-1.5"
            style={{ backgroundColor, opacity: disabled ? 0.4 : 1 }}
            hitSlop={Platform.OS === 'web' ? undefined : { top: 6, bottom: 6, left: 4, right: 4 }}
        >
            <FileDiff size={16} color={color} />
        </Pressable>
    )
}
