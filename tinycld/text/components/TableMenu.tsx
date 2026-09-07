import type { EditorCommands } from '@tinycld/core/lib/editor/types'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { Menu } from '@tinycld/core/ui/menu'
import { usePopoverContext } from '@tinycld/core/ui/popover'
import { useState } from 'react'
import { type GestureResponderEvent, Platform, Pressable, Text, View } from 'react-native'
import {
    cellAtPosition,
    clampGridSelection,
    GRID_PICKER_DEFAULT_COLS,
    GRID_PICKER_DEFAULT_ROWS,
    type GridPickerCell,
    isCellHighlighted,
} from './table-grid-picker-model'

interface TableMenuProps {
    isOpen: boolean
    onOpenChange: (open: boolean) => void
    isInTable: boolean
    canMergeCells: boolean
    canSplitCell: boolean
    commands: EditorCommands
    // The menu anchors to this element and clones it with the onPress
    // that toggles the menu plus the ref it measures, so it must be a
    // single element that forwards both to a Pressable.
    trigger: React.ReactElement
}

const CELL_SIZE = 18
const CELL_GAP = 2

// TableMenu is anchored under the toolbar "Table" button. The content
// depends on caret position:
//   - Caret NOT in a table → interactive grid picker for inserting
//     a new table. Row/column ops would no-op so we hide them.
//   - Caret IS in a table  → row/column add/delete operations. The
//     grid picker is hidden because inserting a new table while inside
//     one is rarely useful (you'd nest tables, which most users don't
//     want).
//
// Selection highlight uses the brand `primary` color rather than
// `accent` — the light-mode `accent` token is a near-white pastel that
// renders invisible against the popover surface.
export function TableMenu({
    isOpen,
    onOpenChange,
    isInTable,
    canMergeCells,
    canSplitCell,
    commands,
    trigger,
}: TableMenuProps) {
    return (
        <Menu
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            trigger={trigger}
            placement="bottom-start"
            title="Table"
        >
            <TableMenuBody
                isInTable={isInTable}
                canMergeCells={canMergeCells}
                canSplitCell={canSplitCell}
                commands={commands}
            />
        </Menu>
    )
}

interface TableMenuBodyProps {
    isInTable: boolean
    canMergeCells: boolean
    canSplitCell: boolean
    commands: EditorCommands
}

function TableMenuBody({ isInTable, canMergeCells, canSplitCell, commands }: TableMenuBodyProps) {
    const { close } = usePopoverContext()
    if (isInTable) {
        return (
            <Menu.Section label="Table">
                <Menu.Item label="Add row above" onSelect={() => commands.addRowBefore?.()} />
                <Menu.Item label="Add row below" onSelect={() => commands.addRowAfter?.()} />
                <Menu.Item label="Add column left" onSelect={() => commands.addColumnBefore?.()} />
                <Menu.Item label="Add column right" onSelect={() => commands.addColumnAfter?.()} />
                <Menu.Separator />
                <Menu.Item
                    label="Merge cells"
                    isDisabled={!canMergeCells}
                    onSelect={() => commands.mergeCells?.()}
                />
                <Menu.Item
                    label="Split cell"
                    isDisabled={!canSplitCell}
                    onSelect={() => commands.splitCell?.()}
                />
                <Menu.Separator />
                <Menu.Item label="Delete row" onSelect={() => commands.deleteRow?.()} />
                <Menu.Item label="Delete column" onSelect={() => commands.deleteColumn?.()} />
                <Menu.Item label="Delete table" onSelect={() => commands.deleteTable?.()} />
            </Menu.Section>
        )
    }

    return (
        <Menu.Custom className="p-3 gap-2">
            <Text className="text-xs font-semibold text-foreground">Insert table</Text>
            <TableGridPicker
                onInsert={cell => {
                    commands.insertTable?.(cell.row, cell.col)
                    close()
                }}
            />
        </Menu.Custom>
    )
}

interface TableGridPickerProps {
    onInsert: (cell: GridPickerCell) => void
    maxRows?: number
    maxCols?: number
}

// The interactive grid. On web, hover updates the highlight; click
// inserts. On native, pan-style touch updates the highlight as the
// finger moves; releasing inserts.
function TableGridPicker({
    onInsert,
    maxRows = GRID_PICKER_DEFAULT_ROWS,
    maxCols = GRID_PICKER_DEFAULT_COLS,
}: TableGridPickerProps) {
    const [hovered, setHovered] = useState<GridPickerCell | null>(null)
    // primary (brand teal) instead of `accent`: the light-mode accent
    // token is a near-white pastel that disappears against the popover
    // background — `primary` gives an unambiguous highlight in both
    // light and dark mode.
    const primary = useThemeColor('primary')
    const border = useThemeColor('border')
    const cellStride = CELL_SIZE + CELL_GAP

    const cells: { row: number; col: number }[] = []
    for (let r = 1; r <= maxRows; r++) {
        for (let c = 1; c <= maxCols; c++) {
            cells.push({ row: r, col: c })
        }
    }

    const handleTouchMove = (event: GestureResponderEvent) => {
        const { locationX, locationY } = event.nativeEvent
        const cell = cellAtPosition(locationX, locationY, cellStride, maxRows, maxCols)
        if (cell) setHovered(cell)
    }

    return (
        <View>
            <View
                accessibilityLabel="Table size grid"
                onStartShouldSetResponder={() => true}
                onMoveShouldSetResponder={() => true}
                onResponderGrant={handleTouchMove}
                onResponderMove={handleTouchMove}
                onResponderRelease={() => {
                    if (hovered) onInsert(clampGridSelection(hovered, maxRows, maxCols))
                }}
                onResponderTerminate={() => setHovered(null)}
                style={{
                    width: maxCols * cellStride - CELL_GAP,
                    height: maxRows * cellStride - CELL_GAP,
                    position: 'relative',
                }}
            >
                {cells.map(cell => {
                    const highlighted = isCellHighlighted(cell, hovered)
                    return (
                        <Pressable
                            key={`${cell.row}-${cell.col}`}
                            accessibilityRole="button"
                            accessibilityLabel={`${cell.row} by ${cell.col} table`}
                            onHoverIn={Platform.OS === 'web' ? () => setHovered(cell) : undefined}
                            onPress={() => onInsert(cell)}
                            style={{
                                position: 'absolute',
                                left: (cell.col - 1) * cellStride,
                                top: (cell.row - 1) * cellStride,
                                width: CELL_SIZE,
                                height: CELL_SIZE,
                                backgroundColor: highlighted ? primary : 'transparent',
                                borderColor: highlighted ? primary : border,
                                borderWidth: 1,
                                borderRadius: 2,
                            }}
                        />
                    )
                })}
            </View>
            <Text className="text-xs text-muted-foreground mt-1.5 text-center">
                {hovered ? `${hovered.row} × ${hovered.col}` : 'Hover to choose size'}
            </Text>
        </View>
    )
}
