import { Menu, MenuBarMenu } from '@tinycld/core/ui/menubar'
import type { MenuBarProps } from './MenuBar'

export function FormatMenu(props: MenuBarProps) {
    const { commands, toolbarState, disabled } = props
    const isInTable = toolbarState.isInTable ?? false
    const tableOpsDisabled = disabled || !isInTable
    const isNormalText =
        toolbarState.activeHeadingLevel == null || toolbarState.activeHeadingLevel === 0
    const isAlignedLeft = toolbarState.currentAlign === 'left' || toolbarState.currentAlign == null

    const toggleNormalText = () => {
        const lvl = toolbarState.activeHeadingLevel
        if (lvl != null) commands.toggleHeading(lvl)
    }

    return (
        <MenuBarMenu menuId="format" label="Format">
            <Menu.Sub label="Text">
                <Menu.Item
                    label="Bold"
                    shortcut="⌘B"
                    isSelected={toolbarState.isBoldActive}
                    onSelect={() => commands.toggleBold()}
                    isDisabled={disabled}
                />
                <Menu.Item
                    label="Italic"
                    shortcut="⌘I"
                    isSelected={toolbarState.isItalicActive}
                    onSelect={() => commands.toggleItalic()}
                    isDisabled={disabled}
                />
                <Menu.Item
                    label="Underline"
                    shortcut="⌘U"
                    isSelected={toolbarState.isUnderlineActive}
                    onSelect={() => commands.toggleUnderline()}
                    isDisabled={disabled}
                />
                <Menu.Item
                    label="Inline code"
                    shortcut="⌘`"
                    isSelected={toolbarState.isCodeActive ?? false}
                    onSelect={() => commands.toggleCode?.()}
                    isDisabled={disabled}
                />
                <Menu.Item
                    label="Code block"
                    shortcut="⌘⇧`"
                    isSelected={toolbarState.isCodeBlockActive ?? false}
                    onSelect={() => commands.toggleCodeBlock?.()}
                    isDisabled={disabled}
                />
            </Menu.Sub>
            <Menu.Sub label="Paragraph styles">
                <Menu.Item
                    label="Normal text"
                    isSelected={isNormalText}
                    onSelect={toggleNormalText}
                    isDisabled={disabled || toolbarState.activeHeadingLevel == null}
                />
                <Menu.Item
                    label="Heading 1"
                    isSelected={toolbarState.activeHeadingLevel === 1}
                    onSelect={() => commands.toggleHeading(1)}
                    isDisabled={disabled}
                />
                <Menu.Item
                    label="Heading 2"
                    isSelected={toolbarState.activeHeadingLevel === 2}
                    onSelect={() => commands.toggleHeading(2)}
                    isDisabled={disabled}
                />
                <Menu.Item
                    label="Heading 3"
                    isSelected={toolbarState.activeHeadingLevel === 3}
                    onSelect={() => commands.toggleHeading(3)}
                    isDisabled={disabled}
                />
            </Menu.Sub>
            <Menu.Sub label="Bullets & numbering">
                <Menu.Item
                    label="Bulleted list"
                    isSelected={toolbarState.isBulletListActive}
                    onSelect={() => commands.toggleBulletList()}
                    isDisabled={disabled}
                />
                <Menu.Item
                    label="Numbered list"
                    isSelected={toolbarState.isOrderedListActive}
                    onSelect={() => commands.toggleOrderedList()}
                    isDisabled={disabled}
                />
                <Menu.Item
                    label="Blockquote"
                    isSelected={toolbarState.isBlockquoteActive}
                    onSelect={() => commands.toggleBlockquote()}
                    isDisabled={disabled}
                />
                <Menu.Item
                    label="Drop cap"
                    isSelected={toolbarState.isDropCapActive ?? false}
                    onSelect={() => commands.toggleDropCap?.()}
                    isDisabled={disabled}
                />
            </Menu.Sub>
            <Menu.Sub label="Align & indent">
                <Menu.Item
                    label="Align left"
                    shortcut="⌘⇧L"
                    isSelected={isAlignedLeft}
                    onSelect={() => commands.setTextAlign?.('left')}
                    isDisabled={disabled}
                />
                <Menu.Item
                    label="Center"
                    shortcut="⌘⇧E"
                    isSelected={toolbarState.currentAlign === 'center'}
                    onSelect={() => commands.setTextAlign?.('center')}
                    isDisabled={disabled}
                />
                <Menu.Item
                    label="Align right"
                    shortcut="⌘⇧R"
                    isSelected={toolbarState.currentAlign === 'right'}
                    onSelect={() => commands.setTextAlign?.('right')}
                    isDisabled={disabled}
                />
                <Menu.Item
                    label="Justify"
                    shortcut="⌘⇧J"
                    isSelected={toolbarState.currentAlign === 'justify'}
                    onSelect={() => commands.setTextAlign?.('justify')}
                    isDisabled={disabled}
                />
                <Menu.Separator />
                <Menu.Item
                    label="Increase indent"
                    shortcut="⌘]"
                    onSelect={() => commands.indentBlock?.()}
                    isDisabled={disabled || !(toolbarState.canIndent ?? false)}
                />
                <Menu.Item
                    label="Decrease indent"
                    shortcut="⌘["
                    onSelect={() => commands.outdentBlock?.()}
                    isDisabled={disabled || !(toolbarState.canOutdent ?? false)}
                />
            </Menu.Sub>
            <Menu.Separator />
            <Menu.Sub label="Table">
                <Menu.Item
                    label="Insert row above"
                    onSelect={() => commands.addRowBefore?.()}
                    isDisabled={tableOpsDisabled}
                />
                <Menu.Item
                    label="Insert row below"
                    onSelect={() => commands.addRowAfter?.()}
                    isDisabled={tableOpsDisabled}
                />
                <Menu.Item
                    label="Insert column left"
                    onSelect={() => commands.addColumnBefore?.()}
                    isDisabled={tableOpsDisabled}
                />
                <Menu.Item
                    label="Insert column right"
                    onSelect={() => commands.addColumnAfter?.()}
                    isDisabled={tableOpsDisabled}
                />
                <Menu.Separator />
                <Menu.Item
                    label="Delete row"
                    onSelect={() => commands.deleteRow?.()}
                    isDisabled={tableOpsDisabled}
                />
                <Menu.Item
                    label="Delete column"
                    onSelect={() => commands.deleteColumn?.()}
                    isDisabled={tableOpsDisabled}
                />
                <Menu.Item
                    label="Delete table"
                    onSelect={() => commands.deleteTable?.()}
                    isDisabled={tableOpsDisabled}
                />
            </Menu.Sub>
        </MenuBarMenu>
    )
}
