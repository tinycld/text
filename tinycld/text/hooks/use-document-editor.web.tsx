import type {
    EditorCommands,
    EditorHandle,
    EditorResult,
    EditorToolbarState,
} from '@tinycld/core/lib/editor/types'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { Color } from '@tiptap/extension-color'
import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import { Table } from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import { TextStyle } from '@tiptap/extension-text-style'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useMemo } from 'react'
import { View } from 'react-native'
import type { Awareness } from 'y-protocols/awareness'
import type * as Y from 'yjs'
import { applyCellBorders } from '../lib/apply-cell-borders'
import { BorderedTableCell, BorderedTableHeader } from '../lib/bordered-table-cells'
import { EDITOR_CONTENT_STYLES } from '../lib/editor-content-styles'

// WrappedImage extends TipTap's default Image with:
//   - inline=true so the node can live inside a paragraph (required
//     by the importer's tree shape: images sit alongside text inside
//     the surrounding paragraph, with `wrap` driving CSS float).
//   - a `wrap` attribute serialized to `data-wrap` on the rendered
//     <img> so editor-content-styles.ts can match img[data-wrap=…]
//     and apply float:left / float:right.
//
// The importer (translate/docx_to_pm.go) reads OOXML wrap modes off
// <wp:anchor> + <wp:positionH><wp:align> and emits wrap=left|right;
// the emitter rewrites the same attr back to ImagePositionFloatLeft/
// FloatRight + ImageWrapSquare on save.
const WrappedImage = Image.extend({
    inline: true,
    group: 'inline',
    addAttributes() {
        return {
            ...this.parent?.(),
            wrap: {
                default: null,
                parseHTML: (el) => el.getAttribute('data-wrap'),
                renderHTML: (attrs) => {
                    if (!attrs.wrap) return {}
                    return { 'data-wrap': attrs.wrap as string }
                },
            },
        }
    },
})

// Inject the document-editor content stylesheet once per page. Tailwind/
// Uniwind preflight strips browser defaults for h1–h6, ul, ol, a, etc.,
// so without this stylesheet an imported .docx renders as a wall of
// 14px text with no heading hierarchy, list markers, or link styling.
// The rules live in editor-content-styles.ts and are shared with the
// WebView editor used on native.
const EDITOR_STYLE_TAG_ID = 'tinycld-text-editor-styles'
if (typeof document !== 'undefined' && !document.getElementById(EDITOR_STYLE_TAG_ID)) {
    const style = document.createElement('style')
    style.id = EDITOR_STYLE_TAG_ID
    style.textContent = EDITOR_CONTENT_STYLES
    document.head.appendChild(style)
}

export interface UseDocumentEditorOptions {
    // Required: the Collaboration extension (yjs binding via Tiptap's
    // bundled y-tiptap, a fork of y-prosemirror) binds to a
    // Y.XmlFragment named "prosemirror" inside this Y.Doc. Caller must
    // hold the Y.Doc open for the lifetime of the editor.
    yDoc: Y.Doc
    // Required: shared awareness for the same room. Cursor positions
    // and presence info ride on this. Use the `user` option below to
    // set the local user identity for collaboration cursors —
    // CollaborationCaret writes its `user` option into awareness.user
    // on mount, so any pre-mount awareness.setLocalStateField('user', ...)
    // would be clobbered.
    awareness: Awareness
    // Optional: local user identity to display in collaboration cursors
    // (the floating cursor labels other peers see). The CollaborationCaret
    // extension writes this into awareness.user on mount; if omitted,
    // peers see anonymous cursors.
    user?: { name: string; color: string }
    // editable=false renders the editor in read-only mode. Tiptap's
    // editable property can be flipped after mount, but for v1 we set it
    // at construction time (consumers pass `editable: !readOnly` from
    // the room's serverHello).
    editable?: boolean
    // Optional placeholder shown when the doc is empty.
    placeholder?: string
    // Accepted for parity with the native variant; ignored on web,
    // where the parent useRealtimeRoom already passes us a connected
    // Y.Doc.
    driveItemId?: string
}

// useDocumentEditor returns a Tiptap editor configured for collaborative
// .docx-style document editing. The hook MUST be called only after the
// caller has a Y.Doc + Awareness pair from a connected realtime room —
// Tiptap's Collaboration extension cannot be reconfigured after mount.
//
// Web variant: uses @tiptap/react directly (no WebView). Mounts
// <EditorContent /> in the DOM. Companion: use-document-editor.native.tsx
// is a v1 stub showing a "coming soon" placeholder.
export function useDocumentEditor(options: UseDocumentEditorOptions): EditorResult {
    const placeholderColor = useThemeColor('field-placeholder')
    const primaryColor = useThemeColor('primary')
    const foregroundColor = useThemeColor('foreground')
    const mutedColor = useThemeColor('muted-foreground')
    const borderColor = useThemeColor('border')
    const linkColor = useThemeColor('link')
    const surfaceSecondaryColor = useThemeColor('surface-secondary')

    const tiptapEditor = useEditor(
        {
            // Tiptap v3's useEditor defaults to NOT re-rendering on every
            // transaction (perf opt-out). Without this flag, toolbarState
            // below freezes at mount-time values — isActive('table'),
            // can().mergeCells(), can().splitCell(), and friends never
            // update as the caret moves, so the toolbar permanently
            // believes you're not in a table. Flip it on so each
            // transaction triggers a re-render and the inline toolbar
            // state stays in sync with the editor.
            shouldRerenderOnTransaction: true,
            editable: options.editable ?? true,
            extensions: [
                // StarterKit bundles paragraphs, headings, bold, italic,
                // underline, link, bullet/ordered lists, blockquote, and
                // undo/redo. The Collaboration extension below provides
                // yjs-aware history, so we disable StarterKit's local
                // undoRedo (was named "history" in tiptap v2) to avoid
                // both running. The `link` config flows through to
                // StarterKit's bundled Link extension; do NOT re-import
                // @tiptap/extension-link or @tiptap/extension-underline
                // separately — Tiptap's findDuplicates would warn and
                // duplicate keymaps cause flaky toolbar behavior.
                StarterKit.configure({
                    undoRedo: false,
                    link: { openOnClick: false },
                }),
                // TextStyle + Color provide the `textStyle` mark with a
                // `color` attribute. The .docx importer maps <w:color> on
                // a run to this mark, so headings/runs that carry an
                // explicit color in Word render with the same color here.
                TextStyle,
                Color,
                Placeholder.configure({ placeholder: options.placeholder ?? 'Start writing…' }),
                // Column resize: Tiptap's TableView mounts a
                // columnResizing plugin that draws drag handles on
                // every cell boundary and writes the dragged width
                // back to the cell's `colwidth` attribute on mouseup.
                // BorderedTableCell extends the upstream TableCell with
                // `...this.parent?.()` so colwidth + colspan + rowspan
                // are preserved — resize state flows through unchanged.
                // cellMinWidth keeps a column from being dragged to 0
                // (which would render as a 1px-wide slice).
                Table.configure({ resizable: true, handleWidth: 5, cellMinWidth: 32 }),
                TableRow,
                BorderedTableHeader,
                BorderedTableCell,
                WrappedImage,
                Collaboration.configure({
                    document: options.yDoc,
                    field: 'prosemirror',
                }),
                CollaborationCaret.configure({
                    provider: { awareness: options.awareness },
                    user: options.user,
                }),
            ],
        },
        [options.yDoc, options.awareness, options.user?.name, options.user?.color]
    )

    const editor: EditorHandle = useMemo(
        () => ({
            getHTML: () => Promise.resolve(tiptapEditor?.getHTML() ?? ''),
            getText: () => Promise.resolve(tiptapEditor?.getText() ?? ''),
            setContent: (_html: string) => {
                // No-op on collaborative editors: directly setting content via
                // ProseMirror would trigger a destructive Yjs replace, blowing
                // away every peer's state. Seed the Y.Doc on the server side
                // (e.g. via translate.SeedFromPMJSON) instead.
                if (typeof console !== 'undefined') {
                    // biome-ignore lint/suspicious/noConsole: developer-error guard for a footgun API on collaborative editors
                    console.warn(
                        'useDocumentEditor.setContent is a no-op for collaborative editors; seed the Y.Doc instead'
                    )
                }
            },
            focus: (position?: 'start' | 'end') => {
                if (position === 'start') {
                    tiptapEditor?.chain().focus('start').run()
                } else {
                    tiptapEditor?.chain().focus('end').run()
                }
            },
            clear: () => tiptapEditor?.commands.clearContent(),
            getSelection: () => {
                const selection = tiptapEditor?.state.selection
                if (!selection) return Promise.resolve(null)
                return Promise.resolve({ from: selection.from, to: selection.to })
            },
        }),
        [tiptapEditor]
    )

    const commands: EditorCommands = useMemo(
        () => ({
            toggleBold: () => tiptapEditor?.chain().focus().toggleBold().run(),
            toggleItalic: () => tiptapEditor?.chain().focus().toggleItalic().run(),
            toggleUnderline: () => tiptapEditor?.chain().focus().toggleUnderline().run(),
            toggleBulletList: () => tiptapEditor?.chain().focus().toggleBulletList().run(),
            toggleOrderedList: () => tiptapEditor?.chain().focus().toggleOrderedList().run(),
            toggleBlockquote: () => tiptapEditor?.chain().focus().toggleBlockquote().run(),
            toggleHeading: (level: number) =>
                tiptapEditor
                    ?.chain()
                    .focus()
                    .toggleHeading({ level: level as 1 | 2 | 3 | 4 | 5 | 6 })
                    .run(),
            setLink: (url: string) => tiptapEditor?.chain().focus().setLink({ href: url }).run(),
            removeLink: () => tiptapEditor?.chain().focus().unsetLink().run(),
            undo: () => tiptapEditor?.chain().focus().undo().run(),
            redo: () => tiptapEditor?.chain().focus().redo().run(),
            insertTable: (rows: number, cols: number) =>
                tiptapEditor
                    ?.chain()
                    .focus()
                    .insertTable({ rows, cols, withHeaderRow: true })
                    .run(),
            addRowBefore: () => tiptapEditor?.chain().focus().addRowBefore().run(),
            addRowAfter: () => tiptapEditor?.chain().focus().addRowAfter().run(),
            addColumnBefore: () => tiptapEditor?.chain().focus().addColumnBefore().run(),
            addColumnAfter: () => tiptapEditor?.chain().focus().addColumnAfter().run(),
            deleteRow: () => tiptapEditor?.chain().focus().deleteRow().run(),
            deleteColumn: () => tiptapEditor?.chain().focus().deleteColumn().run(),
            deleteTable: () => tiptapEditor?.chain().focus().deleteTable().run(),
            // Merge/split: skip the .focus() that other commands use.
            // chain().focus() resets the editor's selection back to its
            // last text selection (via ProseMirror's domSerializer
            // round-trip), which destroys a CellSelection set by
            // shift-drag. Run the command directly on the existing
            // selection so the multi-cell selection survives the click
            // on the menu item.
            mergeCells: () => tiptapEditor?.chain().mergeCells().run(),
            splitCell: () => tiptapEditor?.chain().splitCell().run(),
            mergeOrSplit: () => tiptapEditor?.chain().mergeOrSplit().run(),
            insertImage: (src: string, alt?: string) =>
                tiptapEditor?.chain().focus().setImage({ src, alt }).run(),
            setCellBorders: (preset, border) => {
                if (!tiptapEditor) return
                tiptapEditor.commands.focus()
                applyCellBorders(tiptapEditor, { preset, border })
            },
            cut: () => {
                tiptapEditor?.commands.focus()
                document.execCommand('cut')
            },
            copy: () => {
                tiptapEditor?.commands.focus()
                document.execCommand('copy')
            },
            paste: () => {
                // execCommand('paste') is blocked in modern browsers
                // outside of dedicated extensions, so reach for the
                // async Clipboard API. Inserting through Tiptap's
                // insertContent keeps the change as a single
                // collaborative transaction.
                tiptapEditor?.commands.focus()
                navigator.clipboard
                    ?.readText()
                    .then(text => {
                        if (!text) return
                        tiptapEditor?.chain().focus().insertContent(text).run()
                    })
                    .catch(() => undefined)
            },
            deleteSelection: () => tiptapEditor?.chain().focus().deleteSelection().run(),
            selectAll: () => tiptapEditor?.chain().focus().selectAll().run(),
        }),
        [tiptapEditor]
    )

    const toolbarState: EditorToolbarState = {
        isBoldActive: tiptapEditor?.isActive('bold') ?? false,
        isItalicActive: tiptapEditor?.isActive('italic') ?? false,
        isUnderlineActive: tiptapEditor?.isActive('underline') ?? false,
        isBulletListActive: tiptapEditor?.isActive('bulletList') ?? false,
        isOrderedListActive: tiptapEditor?.isActive('orderedList') ?? false,
        isBlockquoteActive: tiptapEditor?.isActive('blockquote') ?? false,
        isLinkActive: tiptapEditor?.isActive('link') ?? false,
        currentLink: (tiptapEditor?.getAttributes('link')?.href as string) ?? null,
        activeHeadingLevel: ((): number | null => {
            for (let level = 1; level <= 6; level++) {
                if (tiptapEditor?.isActive('heading', { level })) return level
            }
            return null
        })(),
        isInTable: tiptapEditor?.isActive('table') ?? false,
        selectionEmpty: tiptapEditor?.state.selection.empty ?? true,
        // editor.can() runs the command's check predicate without
        // actually dispatching the transaction. For mergeCells that
        // means "is the current selection a CellSelection that spans
        // a mergeable rectangle". For splitCell it means "does the
        // caret sit in a cell with colspan>1 or rowspan>1".
        canMergeCells: tiptapEditor?.can().mergeCells() ?? false,
        canSplitCell: tiptapEditor?.can().splitCell() ?? false,
    }

    const EditorComponent = useMemo(
        () =>
            function DocumentEditorContent() {
                return (
                    <View
                        className="flex-1 min-h-[200px] tinycld-document-editor"
                        style={{
                            // @ts-expect-error CSS custom properties for web
                            '--editor-placeholder-color': placeholderColor,
                            '--editor-primary-color': primaryColor,
                            '--editor-foreground': foregroundColor,
                            '--editor-muted': mutedColor,
                            '--editor-border': borderColor,
                            '--editor-link': linkColor,
                            '--editor-placeholder': placeholderColor,
                            '--editor-table-header': surfaceSecondaryColor,
                        }}
                    >
                        <EditorContent editor={tiptapEditor} />
                    </View>
                )
            },
        [
            tiptapEditor,
            placeholderColor,
            primaryColor,
            foregroundColor,
            mutedColor,
            borderColor,
            linkColor,
            surfaceSecondaryColor,
        ]
    )

    return { editor, EditorComponent, commands, toolbarState }
}
