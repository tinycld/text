import type { EditorCommands } from '@tinycld/core/lib/editor/types'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { Menu } from '@tinycld/core/ui/menu'
import { ChevronDown } from 'lucide-react-native'
import { useState } from 'react'
import { Platform, Pressable, Text } from 'react-native'
import { FONT_SIZE_OPTIONS } from '../lib/font-options'

export { FONT_SIZE_OPTIONS } from '../lib/font-options'

interface FontSizePickerProps {
    currentPx: number | null
    commands: EditorCommands
    disabled?: boolean
}

// The label shown on the trigger when no fontSize attr is set. The
// editor's document-level CSS picks whatever the surrounding style
// gives (h1=2em, paragraph=1em, etc.), so "Default" is honest.
const DEFAULT_LABEL = 'Default'

// FontSizePicker renders a trigger button with the current size (or
// "Default") and opens a list anchored under the trigger when tapped.
// Selecting an option fires setFontSize/unsetFontSize on the editor
// commands.
export function FontSizePicker({ currentPx, commands, disabled = false }: FontSizePickerProps) {
    const [open, setOpen] = useState(false)
    const muted = useThemeColor('muted-foreground')
    const label = currentPx == null ? DEFAULT_LABEL : `${currentPx}`

    const pick = (px: number | null) => {
        if (px == null) {
            commands.unsetFontSize?.()
            return
        }
        commands.setFontSize?.(px)
    }

    // Stop the mousedown from moving DOM focus off ProseMirror — same
    // rationale as DocumentToolbar's FormatButton: the editor's blur
    // handler collapses its selection on focus loss, so a picker that
    // takes focus would clear the user's selection before its command
    // runs.
    const webProps =
        Platform.OS === 'web'
            ? { onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault() }
            : {}

    const triggerOpacity = disabled ? 0.4 : 1

    return (
        <Menu
            isOpen={open}
            onOpenChange={setOpen}
            placement="bottom-start"
            width={140}
            title="Font size"
            trigger={
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Font size"
                    accessibilityState={{ expanded: open, disabled }}
                    disabled={disabled}
                    {...webProps}
                    className="flex-row items-center gap-1 px-2 py-1 rounded-md"
                    style={{ opacity: triggerOpacity }}
                >
                    <Text className="text-sm text-foreground min-w-[24px] text-center">
                        {label}
                    </Text>
                    <ChevronDown size={12} color={muted} />
                </Pressable>
            }
        >
            <Menu.Item
                label={DEFAULT_LABEL}
                isSelected={currentPx == null}
                onSelect={() => pick(null)}
            />
            {FONT_SIZE_OPTIONS.map(px => (
                <Menu.Item
                    key={px}
                    label={`${px}`}
                    isSelected={currentPx === px}
                    onSelect={() => pick(px)}
                />
            ))}
        </Menu>
    )
}
