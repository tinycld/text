import type { EditorCommands, EditorToolbarState } from '@tinycld/core/lib/editor/types'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import {
    Bold,
    Heading1,
    Heading2,
    Heading3,
    Image as ImageIcon,
    Italic,
    Link2,
    List,
    ListOrdered,
    Quote,
    Redo2,
    Table as TableIcon,
    Underline,
    Undo2,
} from 'lucide-react-native'
import type { ComponentType } from 'react'
import { useState } from 'react'
import { Platform, Pressable, ScrollView, View } from 'react-native'
import { ImageInsertButton } from './ImageInsertButton'
import { LinkPopover } from './LinkPopover'
import { TableMenu } from './TableMenu'

interface DocumentToolbarProps {
    commands: EditorCommands
    state: EditorToolbarState
    disabled?: boolean
}

// DocumentToolbar lays out the editor's formatting actions in groups
// (marks, headings, lists/blockquote, link, table, image, history). The
// `disabled` prop greys out every button without unmounting them — the
// read-only state in serverHello drives this, and remounting the
// toolbar would cause the popovers (link, table) to drop their state
// every time the room reconnects.
export function DocumentToolbar({ commands, state, disabled = false }: DocumentToolbarProps) {
    const iconColor = useThemeColor('muted-foreground')
    const activeColor = useThemeColor('primary')
    const [linkOpen, setLinkOpen] = useState(false)
    const [tableOpen, setTableOpen] = useState(false)

    return (
        <View className="border-b border-border">
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View className="flex-row items-center gap-0.5 px-2 py-1.5">
                    <FormatButton
                        icon={Bold}
                        accessibilityLabel="Bold"
                        isActive={state.isBoldActive}
                        disabled={disabled}
                        onPress={() => commands.toggleBold()}
                        iconColor={iconColor}
                        activeColor={activeColor}
                    />
                    <FormatButton
                        icon={Italic}
                        accessibilityLabel="Italic"
                        isActive={state.isItalicActive}
                        disabled={disabled}
                        onPress={() => commands.toggleItalic()}
                        iconColor={iconColor}
                        activeColor={activeColor}
                    />
                    <FormatButton
                        icon={Underline}
                        accessibilityLabel="Underline"
                        isActive={state.isUnderlineActive}
                        disabled={disabled}
                        onPress={() => commands.toggleUnderline()}
                        iconColor={iconColor}
                        activeColor={activeColor}
                    />

                    <Separator />

                    <FormatButton
                        icon={Heading1}
                        accessibilityLabel="Heading 1"
                        isActive={state.activeHeadingLevel === 1}
                        disabled={disabled}
                        onPress={() => commands.toggleHeading(1)}
                        iconColor={iconColor}
                        activeColor={activeColor}
                    />
                    <FormatButton
                        icon={Heading2}
                        accessibilityLabel="Heading 2"
                        isActive={state.activeHeadingLevel === 2}
                        disabled={disabled}
                        onPress={() => commands.toggleHeading(2)}
                        iconColor={iconColor}
                        activeColor={activeColor}
                    />
                    <FormatButton
                        icon={Heading3}
                        accessibilityLabel="Heading 3"
                        isActive={state.activeHeadingLevel === 3}
                        disabled={disabled}
                        onPress={() => commands.toggleHeading(3)}
                        iconColor={iconColor}
                        activeColor={activeColor}
                    />

                    <Separator />

                    <FormatButton
                        icon={List}
                        accessibilityLabel="Bullet list"
                        isActive={state.isBulletListActive}
                        disabled={disabled}
                        onPress={() => commands.toggleBulletList()}
                        iconColor={iconColor}
                        activeColor={activeColor}
                    />
                    <FormatButton
                        icon={ListOrdered}
                        accessibilityLabel="Ordered list"
                        isActive={state.isOrderedListActive}
                        disabled={disabled}
                        onPress={() => commands.toggleOrderedList()}
                        iconColor={iconColor}
                        activeColor={activeColor}
                    />
                    <FormatButton
                        icon={Quote}
                        accessibilityLabel="Blockquote"
                        isActive={state.isBlockquoteActive}
                        disabled={disabled}
                        onPress={() => commands.toggleBlockquote()}
                        iconColor={iconColor}
                        activeColor={activeColor}
                    />

                    <Separator />

                    <FormatButton
                        icon={Link2}
                        accessibilityLabel="Link"
                        isActive={state.isLinkActive}
                        disabled={disabled}
                        onPress={() => setLinkOpen(true)}
                        iconColor={iconColor}
                        activeColor={activeColor}
                    />
                    <FormatButton
                        icon={TableIcon}
                        accessibilityLabel="Table"
                        isActive={state.isInTable ?? false}
                        disabled={disabled}
                        onPress={() => setTableOpen(true)}
                        iconColor={iconColor}
                        activeColor={activeColor}
                    />
                    <ImageInsertButton
                        icon={ImageIcon}
                        disabled={disabled}
                        onInsert={dataUri => commands.insertImage?.(dataUri)}
                        iconColor={iconColor}
                    />

                    <Separator />

                    <FormatButton
                        icon={Undo2}
                        accessibilityLabel="Undo"
                        isActive={false}
                        disabled={disabled}
                        onPress={() => commands.undo()}
                        iconColor={iconColor}
                        activeColor={activeColor}
                    />
                    <FormatButton
                        icon={Redo2}
                        accessibilityLabel="Redo"
                        isActive={false}
                        disabled={disabled}
                        onPress={() => commands.redo()}
                        iconColor={iconColor}
                        activeColor={activeColor}
                    />
                </View>
            </ScrollView>

            <LinkPopover
                isOpen={linkOpen}
                initialUrl={state.currentLink ?? ''}
                onCancel={() => setLinkOpen(false)}
                onInsert={url => {
                    if (url) {
                        commands.setLink(url)
                    } else {
                        commands.removeLink()
                    }
                    setLinkOpen(false)
                }}
            />

            <TableMenu
                isOpen={tableOpen}
                isInTable={state.isInTable ?? false}
                onClose={() => setTableOpen(false)}
                commands={commands}
            />
        </View>
    )
}

interface FormatButtonProps {
    icon: ComponentType<{ size: number; color: string }>
    accessibilityLabel: string
    isActive: boolean
    disabled: boolean
    onPress: () => void
    iconColor: string
    activeColor: string
}

function FormatButton({
    icon: Icon,
    accessibilityLabel,
    isActive,
    disabled,
    onPress,
    iconColor,
    activeColor,
}: FormatButtonProps) {
    const backgroundColor = isActive && !disabled ? `${activeColor}22` : undefined
    const opacity = disabled ? 0.4 : 1
    const color = isActive && !disabled ? activeColor : iconColor
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            accessibilityState={{ disabled, selected: isActive }}
            disabled={disabled}
            onPress={onPress}
            className="rounded-md p-1.5"
            style={{ backgroundColor, opacity }}
            hitSlop={Platform.OS === 'web' ? undefined : { top: 6, bottom: 6, left: 4, right: 4 }}
        >
            <Icon size={16} color={color} />
        </Pressable>
    )
}

function Separator() {
    return <View className="w-px h-5 mx-1 bg-border" />
}
