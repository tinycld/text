import { Menu, MenuBarMenu } from '@tinycld/core/ui/menubar'
import { useImageInsert } from '../ImageInsertButton'
import type { MenuBarProps } from './MenuBar'

const TABLE_PRESETS: ReadonlyArray<{ rows: number; cols: number; label: string }> = [
    { rows: 2, cols: 2, label: '2 × 2' },
    { rows: 3, cols: 3, label: '3 × 3' },
    { rows: 4, cols: 4, label: '4 × 4' },
    { rows: 5, cols: 5, label: '5 × 5' },
]

export function InsertMenu(props: MenuBarProps) {
    const { commands, disabled, onRequestInsertLink, onInsertImage } = props
    const handleImage = useImageInsert(onInsertImage)
    const tableDisabled = disabled || commands.insertTable == null

    return (
        <MenuBarMenu menuId="insert" label="Insert">
            <Menu.Item label="Image" onSelect={handleImage} isDisabled={disabled} />
            <Menu.Sub label="Table">
                {TABLE_PRESETS.map(preset => (
                    <Menu.Item
                        key={preset.label}
                        label={preset.label}
                        onSelect={() => commands.insertTable?.(preset.rows, preset.cols)}
                        isDisabled={tableDisabled}
                    />
                ))}
            </Menu.Sub>
            <Menu.Item
                label="Link"
                shortcut="⌘K"
                onSelect={onRequestInsertLink}
                isDisabled={disabled}
            />
        </MenuBarMenu>
    )
}
