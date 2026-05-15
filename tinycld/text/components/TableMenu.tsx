import type { EditorCommands } from '@tinycld/core/lib/editor/types'
import { Modal, Pressable, Text } from 'react-native'

interface TableMenuProps {
    isOpen: boolean
    isInTable: boolean
    onClose: () => void
    commands: EditorCommands
}

interface MenuRowProps {
    label: string
    disabled?: boolean
    onPress: () => void
}

// Minimal table operations menu. Like LinkPopover, this renders as a
// centred Modal — popover positioning over a toolbar button is
// platform-dependent and not worth wiring up in v1. Insert is always
// enabled; the row/column/delete operations are disabled when the
// caret is not currently inside a table (Tiptap's commands no-op in
// that case anyway, but disabling the buttons makes the surface
// honest).
export function TableMenu({ isOpen, isInTable, onClose, commands }: TableMenuProps) {
    if (!isOpen) return null

    const close = (action: () => void) => () => {
        action()
        onClose()
    }

    return (
        <Modal transparent animationType="fade" visible={isOpen} onRequestClose={onClose}>
            <Pressable className="flex-1 items-center justify-center bg-black/30" onPress={onClose}>
                <Pressable className="w-[260px] gap-1 p-2 rounded-lg bg-background border border-border">
                    <MenuRow
                        label="Insert 3×3 table"
                        onPress={close(() => commands.insertTable?.(3, 3))}
                    />
                    <MenuRow
                        label="Add row above"
                        disabled={!isInTable}
                        onPress={close(() => commands.addRowBefore?.())}
                    />
                    <MenuRow
                        label="Add row below"
                        disabled={!isInTable}
                        onPress={close(() => commands.addRowAfter?.())}
                    />
                    <MenuRow
                        label="Add column left"
                        disabled={!isInTable}
                        onPress={close(() => commands.addColumnBefore?.())}
                    />
                    <MenuRow
                        label="Add column right"
                        disabled={!isInTable}
                        onPress={close(() => commands.addColumnAfter?.())}
                    />
                    <MenuRow
                        label="Delete row"
                        disabled={!isInTable}
                        onPress={close(() => commands.deleteRow?.())}
                    />
                    <MenuRow
                        label="Delete column"
                        disabled={!isInTable}
                        onPress={close(() => commands.deleteColumn?.())}
                    />
                    <MenuRow
                        label="Delete table"
                        disabled={!isInTable}
                        onPress={close(() => commands.deleteTable?.())}
                    />
                </Pressable>
            </Pressable>
        </Modal>
    )
}

function MenuRow({ label, disabled = false, onPress }: MenuRowProps) {
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={onPress}
            className="px-3 py-2 rounded-md hover:bg-surface-secondary"
            style={disabled ? { opacity: 0.4 } : undefined}
        >
            <Text className="text-sm text-foreground">{label}</Text>
        </Pressable>
    )
}
