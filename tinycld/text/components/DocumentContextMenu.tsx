import { ContextMenu } from '@tinycld/core/components/ContextMenu'
import type { EditorCommands, EditorToolbarState } from '@tinycld/core/lib/editor/types'
import { Menu } from '@tinycld/core/ui/menu'
import type { LucideIcon } from 'lucide-react-native'
import {
    ClipboardPaste,
    Columns,
    Copy,
    Link as LinkIcon,
    Merge,
    MessageSquarePlus,
    Rows,
    Scissors,
    Split,
    Table as TableIcon,
    TextSelect,
    Trash2,
} from 'lucide-react-native'
import { Fragment, type ReactNode } from 'react'
import { Platform } from 'react-native'
import { buildDocumentContextMenu, type ContextMenuItemId } from './document-context-menu-items'

interface DocumentContextMenuProps {
    children: ReactNode
    commands: EditorCommands
    toolbarState: EditorToolbarState
    editable: boolean
    onRequestInsertLink: () => void
    onRequestAddComment?: () => void
    canAddComment?: boolean
    className?: string
}

// Right-click (web) / long-press (native) menu for the document editor.
// Items shown depend on toolbarState — when the caret is inside a
// table, a table-operations cluster is appended. Disabled items stay
// visible (greyed out) to match desktop word processor conventions
// rather than hiding them, which would make the menu jump in size as
// the selection changes.
//
// The visibility/disabling rules live in document-context-menu-items.ts
// so they can be unit-tested without rendering React. This component
// only maps the descriptors onto icons + shortcuts.
export function DocumentContextMenu({
    children,
    commands,
    toolbarState,
    editable,
    onRequestInsertLink,
    onRequestAddComment,
    canAddComment = false,
    className,
}: DocumentContextMenuProps) {
    return (
        <ContextMenu
            className={className}
            content={() => (
                <MenuContent
                    commands={commands}
                    toolbarState={toolbarState}
                    editable={editable}
                    onRequestInsertLink={onRequestInsertLink}
                    onRequestAddComment={onRequestAddComment}
                    canAddComment={canAddComment}
                />
            )}
        >
            {children}
        </ContextMenu>
    )
}

interface MenuContentProps {
    commands: EditorCommands
    toolbarState: EditorToolbarState
    editable: boolean
    onRequestInsertLink: () => void
    onRequestAddComment?: () => void
    canAddComment: boolean
}

function MenuContent({
    commands,
    toolbarState,
    editable,
    onRequestInsertLink,
    onRequestAddComment,
    canAddComment,
}: MenuContentProps) {
    const groups = buildDocumentContextMenu({
        commands,
        toolbarState,
        editable,
        onRequestInsertLink,
        onRequestAddComment,
        canAddComment,
    })

    return (
        <>
            {groups.map((group, groupIndex) => (
                <Fragment key={group.label ?? `group-${groupIndex}`}>
                    {groupIndex > 0 ? <Menu.Separator /> : null}
                    <Group label={group.label}>
                        {group.rows.map(row => (
                            <Row
                                key={row.id}
                                id={row.id}
                                label={row.label}
                                isDisabled={row.isDisabled}
                                onSelect={row.invoke}
                            />
                        ))}
                    </Group>
                </Fragment>
            ))}
        </>
    )
}

// A labelled group is a Menu.Section; an unlabelled one is just its rows.
function Group({ label, children }: { label?: string; children: ReactNode }) {
    if (label == null) return <>{children}</>
    return <Menu.Section label={label}>{children}</Menu.Section>
}

interface IconMeta {
    icon: LucideIcon
    shortcut?: string
}

// Visual presentation for each item id. Keeping this map out of the
// pure helper means a designer-driven icon swap is a one-file edit and
// the unit test doesn't need to care about LucideIcon types.
const ITEM_META: Record<ContextMenuItemId, IconMeta> = {
    cut: { icon: Scissors, shortcut: '⌘X' },
    copy: { icon: Copy, shortcut: '⌘C' },
    paste: { icon: ClipboardPaste, shortcut: '⌘V' },
    delete: { icon: Trash2 },
    'select-all': { icon: TextSelect, shortcut: '⌘A' },
    'insert-link': { icon: LinkIcon, shortcut: '⌘K' },
    'add-comment': { icon: MessageSquarePlus },
    'table-insert-row-above': { icon: Rows },
    'table-insert-row-below': { icon: Rows },
    'table-insert-column-left': { icon: Columns },
    'table-insert-column-right': { icon: Columns },
    'table-merge-cells': { icon: Merge },
    'table-split-cell': { icon: Split },
    'table-delete-row': { icon: Rows },
    'table-delete-column': { icon: Columns },
    'table-delete-table': { icon: TableIcon },
}

interface RowProps {
    id: ContextMenuItemId
    label: string
    isDisabled: boolean
    onSelect: () => void
}

// Shortcuts are keyboard bindings, which only exist on web.
function Row({ id, label, isDisabled, onSelect }: RowProps) {
    const meta = ITEM_META[id]
    const shortcut = Platform.OS === 'web' ? meta.shortcut : undefined
    return (
        <Menu.Item
            label={label}
            icon={meta.icon}
            shortcut={shortcut}
            isDisabled={isDisabled}
            onSelect={onSelect}
        />
    )
}
