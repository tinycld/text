import { useCommentsDrawerStore } from '@tinycld/core/lib/stores/comments-drawer-store'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { MessageSquare } from 'lucide-react-native'
import { Platform, Pressable } from 'react-native'

export interface OpenCommentsDrawerButtonProps {
    driveItemId: string
    disabled?: boolean
}

// Toolbar button that toggles the comments drawer for this document.
// Uses the singleton useCommentsDrawerStore so opening from any
// surface (toolbar, menubar, marker popover) lands in the same place.
export function OpenCommentsDrawerButton({
    driveItemId,
    disabled = false,
}: OpenCommentsDrawerButtonProps) {
    const isOpen = useCommentsDrawerStore(s => s.isOpen)
    const storeDriveItemId = useCommentsDrawerStore(s => s.driveItemId)
    const open = useCommentsDrawerStore(s => s.open)
    const close = useCommentsDrawerStore(s => s.close)
    const iconColor = useThemeColor('muted-foreground')
    const activeColor = useThemeColor('primary')

    const drawerIsOpen = isOpen && storeDriveItemId === driveItemId
    const color = drawerIsOpen ? activeColor : iconColor
    const backgroundColor = drawerIsOpen ? `${activeColor}22` : undefined

    const onPress = () => {
        if (drawerIsOpen) {
            close()
        } else {
            open({ packageSlug: 'text', driveItemId })
        }
    }

    // ProseMirror loses its selection on focus blur, which would make
    // "Comment" with an active selection broken from a toolbar click.
    // The button only opens/closes the drawer — it doesn't itself
    // start a new thread — but match the rest of DocumentToolbar's
    // mousedown-suppression to keep the caret stable.
    const webProps =
        Platform.OS === 'web'
            ? { onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault() }
            : {}

    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel="Comments"
            accessibilityState={{ disabled, selected: drawerIsOpen }}
            disabled={disabled}
            onPress={onPress}
            {...webProps}
            className="rounded-md p-1.5"
            style={{ backgroundColor, opacity: disabled ? 0.4 : 1 }}
            hitSlop={Platform.OS === 'web' ? undefined : { top: 6, bottom: 6, left: 4, right: 4 }}
        >
            <MessageSquare size={16} color={color} />
        </Pressable>
    )
}
