import { HelpSearchButton } from '@tinycld/core/components/help/HelpSearchButton'
import { ResponsiveToolbar, type ToolbarItem } from '@tinycld/core/components/ResponsiveToolbar'
import { Tooltip } from '@tinycld/core/components/Tooltip'
import type { EditorCommands, EditorToolbarState } from '@tinycld/core/lib/editor/types'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import {
    AlignCenter,
    AlignJustify,
    AlignLeft,
    AlignRight,
    Baseline,
    Bold,
    Code,
    Code2,
    Grid3x3,
    Heading1,
    Heading2,
    Heading3,
    Highlighter,
    Image as ImageIcon,
    Indent,
    Italic,
    Link2,
    List,
    ListOrdered,
    type LucideIcon,
    Outdent,
    PaintBucket,
    Quote,
    Redo2,
    Table as TableIcon,
    Underline,
    Undo2,
} from 'lucide-react-native'
import { forwardRef, useState } from 'react'
import { Platform, Pressable, View } from 'react-native'
import type { EditorModeStore } from '../stores/editor-mode-store'
import type { ReviewDrawerStore } from '../stores/review-drawer-store'
import { BorderMenu } from './BorderMenu'
import { NewCommentButton } from './comments/NewCommentButton'
import { EditorModeMenu } from './EditorModeMenu'
import { FontFamilyPicker, FontFamilyRows } from './FontFamilyPicker'
import { FontSizePicker, FontSizeRows } from './FontSizePicker'
import { ImageInsertButton, useImageInsert } from './ImageInsertButton'
import { LinkPopover } from './LinkPopover'
import { ShadingMenu } from './ShadingMenu'
import { OpenReviewDrawerButton } from './suggestions/OpenReviewDrawerButton'
import { TableMenu, TableMenuBody } from './TableMenu'
import { TextColorButton, TextColorRows } from './TextColorButton'

interface DocumentToolbarProps {
    commands: EditorCommands
    state: EditorToolbarState
    disabled?: boolean
    // Handles for the inline new-comment trigger. Omit when the toolbar
    // hosts a doc without the comment system mounted.
    newCommentFlow?: {
        canStart: boolean
        isOpen: boolean
        start: () => void
    }
    // Per-document editor-mode store wired by the screen (see
    // screens/[id].tsx). Optional — when undefined, the mode menu
    // and chip render nothing, so callers that don't yet care about
    // suggestion mode (tests, lightweight tool harnesses) don't have
    // to construct a store.
    modeStore?: EditorModeStore
    // canEdit / canSuggest gate which rows show up in the mode menu.
    // Hard-coded to true at the screen call site for Phase 2a; Task 9
    // replaces those with useSuggestionPermissions(driveItemId).
    canEdit?: boolean
    canSuggest?: boolean
    // Per-document review-drawer store wired by the screen. When the
    // store and driveItemId are both present, the toolbar renders a
    // button that toggles the suggestion review drawer for this doc.
    reviewDrawerStore?: ReviewDrawerStore
    driveItemId?: string
}

// DocumentToolbar lays out the editor's formatting actions in groups
// (marks, headings, lists/blockquote, link, table, image, history) on the
// shared ResponsiveToolbar, so what does not fit the width folds into a
// More menu — the pickers and the table menu as submenus of their own rows.
// The `disabled` prop greys out every button without unmounting them — the
// read-only state in serverHello drives this, and remounting the toolbar
// would cause the popovers (link, table) to drop their state every time the
// room reconnects.
export function DocumentToolbar({
    commands,
    state,
    disabled = false,
    newCommentFlow,
    modeStore,
    canEdit = true,
    canSuggest = true,
    reviewDrawerStore,
    driveItemId,
}: DocumentToolbarProps) {
    const [linkOpen, setLinkOpen] = useState(false)
    const [borderOpen, setBorderOpen] = useState(false)
    const [shadingOpen, setShadingOpen] = useState(false)
    const items = useFormattingItems({
        commands,
        state,
        disabled,
        openLink: () => setLinkOpen(true),
        openBorders: () => setBorderOpen(true),
        openShading: () => setShadingOpen(true),
    })
    const rightItems = useRightItems({
        disabled,
        newCommentFlow,
        modeStore,
        canEdit,
        canSuggest,
        reviewDrawerStore,
        driveItemId,
    })

    return (
        <View className="border-b border-border overflow-visible">
            <ResponsiveToolbar
                items={items}
                rightItems={rightItems}
                height={40}
                className="px-2 py-1.5"
            />

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

            <BorderMenu
                isOpen={borderOpen}
                onClose={() => setBorderOpen(false)}
                commands={commands}
            />

            <ShadingMenu
                isOpen={shadingOpen}
                onClose={() => setShadingOpen(false)}
                commands={commands}
            />
        </View>
    )
}

interface FormattingItemsInput {
    commands: EditorCommands
    state: EditorToolbarState
    disabled: boolean
    openLink: () => void
    openBorders: () => void
    openShading: () => void
}

const SEPARATOR: ToolbarItem = { type: 'separator' }

function useFormattingItems({
    commands,
    state,
    disabled,
    openLink,
    openBorders,
    openShading,
}: FormattingItemsInput): ToolbarItem[] {
    const iconColor = useThemeColor('muted-foreground')
    const activeColor = useThemeColor('primary')
    const [tableOpen, setTableOpen] = useState(false)
    const isInTable = state.isInTable ?? false
    const insertImage = useImageInsert(url => commands.insertImage?.(url))

    const setTextColor = (value: string) => {
        if (value === '') {
            commands.unsetTextColor?.()
        } else {
            commands.setTextColor?.(value)
        }
    }
    const setBackgroundColor = (value: string) => {
        if (value === '') {
            commands.unsetBackgroundColor?.()
        } else {
            commands.setBackgroundColor?.(value)
        }
    }

    // One formatting toggle: the button in the row, the same command as a
    // menu row once it folds.
    const format = (
        key: string,
        icon: FormatIcon,
        label: string,
        isActive: boolean,
        onPress: () => void,
        isDisabled = disabled
    ): ToolbarItem => ({
        type: 'custom',
        key,
        element: (
            <FormatButton
                icon={icon}
                accessibilityLabel={label}
                isActive={isActive}
                disabled={isDisabled}
                onPress={onPress}
                iconColor={iconColor}
                activeColor={activeColor}
            />
        ),
        overflow: { label, icon, onPress, isDisabled },
    })

    return [
        {
            type: 'custom',
            key: 'font-family',
            element: (
                <FontFamilyPicker
                    currentFamily={state.currentFontFamily ?? null}
                    commands={commands}
                    disabled={disabled}
                />
            ),
            overflow: {
                label: 'Font family',
                isDisabled: disabled,
                children: (
                    <FontFamilyRows
                        currentFamily={state.currentFontFamily ?? null}
                        commands={commands}
                    />
                ),
            },
        },
        {
            type: 'custom',
            key: 'font-size',
            element: (
                <FontSizePicker
                    currentPx={state.currentFontSize ?? null}
                    commands={commands}
                    disabled={disabled}
                />
            ),
            overflow: {
                label: 'Font size',
                isDisabled: disabled,
                children: (
                    <FontSizeRows currentPx={state.currentFontSize ?? null} commands={commands} />
                ),
            },
        },
        SEPARATOR,
        format('bold', Bold, 'Bold', state.isBoldActive, () => commands.toggleBold()),
        format('italic', Italic, 'Italic', state.isItalicActive, () => commands.toggleItalic()),
        format('underline', Underline, 'Underline', state.isUnderlineActive, () =>
            commands.toggleUnderline()
        ),
        format('code', Code, 'Inline code', state.isCodeActive ?? false, () =>
            commands.toggleCode?.()
        ),
        format('code-block', Code2, 'Code block', state.isCodeBlockActive ?? false, () =>
            commands.toggleCodeBlock?.()
        ),
        {
            type: 'custom',
            key: 'text-color',
            element: (
                <TextColorButton
                    icon={Baseline}
                    accessibilityLabel="Text color"
                    menuKey="text-color"
                    color={state.currentTextColor ?? undefined}
                    disabled={disabled}
                    iconColor={iconColor}
                    onSelect={setTextColor}
                />
            ),
            overflow: {
                label: 'Text color',
                icon: Baseline,
                isDisabled: disabled,
                children: (
                    <TextColorRows
                        color={state.currentTextColor ?? undefined}
                        onSelect={setTextColor}
                    />
                ),
            },
        },
        {
            type: 'custom',
            key: 'highlight',
            element: (
                <TextColorButton
                    icon={Highlighter}
                    accessibilityLabel="Highlight color"
                    menuKey="background-color"
                    color={state.currentBackgroundColor ?? undefined}
                    disabled={disabled}
                    iconColor={iconColor}
                    onSelect={setBackgroundColor}
                />
            ),
            overflow: {
                label: 'Highlight color',
                icon: Highlighter,
                isDisabled: disabled,
                children: (
                    <TextColorRows
                        color={state.currentBackgroundColor ?? undefined}
                        onSelect={setBackgroundColor}
                    />
                ),
            },
        },
        SEPARATOR,
        format('h1', Heading1, 'Heading 1', state.activeHeadingLevel === 1, () =>
            commands.toggleHeading(1)
        ),
        format('h2', Heading2, 'Heading 2', state.activeHeadingLevel === 2, () =>
            commands.toggleHeading(2)
        ),
        format('h3', Heading3, 'Heading 3', state.activeHeadingLevel === 3, () =>
            commands.toggleHeading(3)
        ),
        SEPARATOR,
        format('bullet', List, 'Bullet list', state.isBulletListActive, () =>
            commands.toggleBulletList()
        ),
        format('ordered', ListOrdered, 'Ordered list', state.isOrderedListActive, () =>
            commands.toggleOrderedList()
        ),
        format('quote', Quote, 'Blockquote', state.isBlockquoteActive, () =>
            commands.toggleBlockquote()
        ),
        SEPARATOR,
        format(
            'align-left',
            AlignLeft,
            'Align left',
            state.currentAlign === 'left' || state.currentAlign == null,
            () => commands.setTextAlign?.('left')
        ),
        format('align-center', AlignCenter, 'Align center', state.currentAlign === 'center', () =>
            commands.setTextAlign?.('center')
        ),
        format('align-right', AlignRight, 'Align right', state.currentAlign === 'right', () =>
            commands.setTextAlign?.('right')
        ),
        format('justify', AlignJustify, 'Justify', state.currentAlign === 'justify', () =>
            commands.setTextAlign?.('justify')
        ),
        format(
            'outdent',
            Outdent,
            'Decrease indent',
            false,
            () => commands.outdentBlock?.(),
            disabled || !(state.canOutdent ?? false)
        ),
        format(
            'indent',
            Indent,
            'Increase indent',
            false,
            () => commands.indentBlock?.(),
            disabled || !(state.canIndent ?? false)
        ),
        SEPARATOR,
        format('link', Link2, 'Link', state.isLinkActive, openLink),
        {
            type: 'custom',
            key: 'table',
            element: (
                <TableMenu
                    isOpen={tableOpen}
                    onOpenChange={setTableOpen}
                    isInTable={isInTable}
                    canMergeCells={state.canMergeCells ?? false}
                    canSplitCell={state.canSplitCell ?? false}
                    commands={commands}
                    trigger={
                        <FormatButton
                            icon={TableIcon}
                            accessibilityLabel="Table"
                            isActive={isInTable}
                            disabled={disabled}
                            onPress={() => undefined}
                            iconColor={iconColor}
                            activeColor={activeColor}
                        />
                    }
                />
            ),
            overflow: {
                label: 'Table',
                icon: TableIcon,
                isDisabled: disabled,
                children: (
                    <TableMenuBody
                        isInTable={isInTable}
                        canMergeCells={state.canMergeCells ?? false}
                        canSplitCell={state.canSplitCell ?? false}
                        commands={commands}
                    />
                ),
            },
        },
        format('borders', Grid3x3, 'Cell borders', false, openBorders, disabled || !isInTable),
        format('shading', PaintBucket, 'Cell shading', false, openShading, disabled || !isInTable),
        {
            type: 'custom',
            key: 'image',
            element: (
                <ImageInsertButton
                    icon={ImageIcon}
                    disabled={disabled}
                    onInsert={url => commands.insertImage?.(url)}
                    iconColor={iconColor}
                />
            ),
            overflow: {
                label: 'Insert image',
                icon: ImageIcon,
                onPress: insertImage,
                isDisabled: disabled,
            },
        },
        SEPARATOR,
        format('undo', Undo2, 'Undo', false, () => commands.undo()),
        format('redo', Redo2, 'Redo', false, () => commands.redo()),
    ]
}

type RightItemsInput = Pick<
    DocumentToolbarProps,
    | 'disabled'
    | 'newCommentFlow'
    | 'modeStore'
    | 'canEdit'
    | 'canSuggest'
    | 'reviewDrawerStore'
    | 'driveItemId'
>

// Comment + suggestion-review affordances are not shown on read-only mounts.
// `disabled` already signals "this is a viewer" via the screen's
// hello.readOnly wiring — by the read-only design decision (see
// screens/[id].tsx) we omit these buttons entirely rather than rendering them
// disabled. The mode menu likewise hides because Viewing is the only
// meaningful mode. Pinned at the right edge: they are the document's chrome,
// not formatting.
function useRightItems({
    disabled,
    newCommentFlow,
    modeStore,
    reviewDrawerStore,
    driveItemId,
    canEdit = true,
    canSuggest = true,
}: RightItemsInput): ToolbarItem[] {
    const items: ToolbarItem[] = []
    if (newCommentFlow && !disabled) {
        items.push(SEPARATOR, {
            type: 'custom',
            key: 'new-comment',
            element: (
                <NewCommentButton
                    canStart={newCommentFlow.canStart}
                    isOpen={newCommentFlow.isOpen}
                    onPress={newCommentFlow.start}
                />
            ),
        })
    }
    if (reviewDrawerStore && driveItemId && !disabled) {
        items.push(SEPARATOR, {
            type: 'custom',
            key: 'review',
            element: (
                <OpenReviewDrawerButton
                    driveItemId={driveItemId}
                    store={reviewDrawerStore}
                    disabled={disabled}
                />
            ),
        })
    }
    if (modeStore) {
        items.push(SEPARATOR, {
            type: 'custom',
            key: 'mode',
            element: (
                <EditorModeMenu modeStore={modeStore} canEdit={canEdit} canSuggest={canSuggest} />
            ),
        })
    }
    items.push({ type: 'custom', key: 'help', element: <HelpSearchButton /> })
    return items
}

type FormatIcon = LucideIcon

interface FormatButtonProps {
    icon: FormatIcon
    accessibilityLabel: string
    isActive: boolean
    disabled: boolean
    onPress: () => void
    iconColor: string
    activeColor: string
}

// forwardRef so a FormatButton can serve as a Menu `trigger` (the Table
// button): the Menu clones its trigger to forward a ref it measures for
// placement, and re-injects a composed onPress (the child's own press +
// the menu-open toggle). FormatButton forwards that ref straight to its
// Pressable and already drives the Pressable from its onPress prop, so
// both work. Tooltip is a Fragment on native, so it must NOT sit
// between the Menu and this Pressable — the Menu clones FormatButton (a
// real component that forwards the ref), not the tooltip, so the nesting
// here is fine.
const FormatButton = forwardRef<View, FormatButtonProps>(function FormatButton(
    { icon: Icon, accessibilityLabel, isActive, disabled, onPress, iconColor, activeColor },
    ref
) {
    const backgroundColor = isActive && !disabled ? `${activeColor}22` : undefined
    const opacity = disabled ? 0.4 : 1
    const color = isActive && !disabled ? activeColor : iconColor
    // Stop the mousedown from moving DOM focus off the ProseMirror
    // editor. ProseMirror's blur handler collapses its selection on
    // focus loss, which makes selection-derived UI (e.g. the Table
    // popover deciding between "insert grid" and "row/col ops") read
    // stale state on the next render. The toolbar buttons all act on
    // a selection in the editor, so they should never take focus.
    // Web-only — on native there's no DOM focus model and the prop is
    // silently dropped by RN.
    const webProps =
        Platform.OS === 'web'
            ? { onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault() }
            : {}
    return (
        <Tooltip label={accessibilityLabel}>
            <Pressable
                ref={ref}
                accessibilityRole="button"
                accessibilityLabel={accessibilityLabel}
                accessibilityState={{ disabled, selected: isActive }}
                disabled={disabled}
                onPress={onPress}
                {...webProps}
                className="rounded-md p-1.5"
                style={{ backgroundColor, opacity }}
                hitSlop={
                    Platform.OS === 'web' ? undefined : { top: 6, bottom: 6, left: 4, right: 4 }
                }
            >
                <Icon size={16} color={color} />
            </Pressable>
        </Tooltip>
    )
})
