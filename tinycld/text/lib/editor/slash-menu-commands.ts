import type { Editor, Range } from '@tiptap/core'
import {
    Code2,
    Heading1,
    Heading2,
    Heading3,
    Image as ImageIcon,
    List,
    ListOrdered,
    type LucideIcon,
    Minus,
    Quote,
    Table as TableIcon,
} from 'lucide-react-native'

// Argument signature for image-insert handlers. The flow is delegated
// to the screen — the slash menu only fires `openImageInsert()`, which
// in turn opens the existing file/URL picker, then routes the resulting
// src back through `commands.insertImage`. Inlining the picker in the
// suggestion plugin would entangle it with the screen-level mutations,
// so we keep it as a callback the host wires in.
export interface SlashMenuCommandContext {
    editor: Editor
    range: Range
    openImageInsert?: () => void
}

export interface SlashMenuCommand {
    id: string
    label: string
    // Search keywords beyond the label. The filter matches against
    // both `label` and `keywords` so users can type "h1" → Heading 1
    // without the label needing to advertise the shorthand.
    keywords: string[]
    icon: LucideIcon
    run: (ctx: SlashMenuCommandContext) => void
}

// Block-insertion commands surfaced by the slash menu. Order here is
// the order shown in the popover when the query is empty. New v1
// entries should be appended unless there's a UX reason to insert
// them mid-list.
export const SLASH_MENU_COMMANDS: SlashMenuCommand[] = [
    {
        id: 'heading-1',
        label: 'Heading 1',
        keywords: ['h1', 'title', 'header'],
        icon: Heading1,
        run: ({ editor, range }) => {
            editor.chain().focus().deleteRange(range).toggleHeading({ level: 1 }).run()
        },
    },
    {
        id: 'heading-2',
        label: 'Heading 2',
        keywords: ['h2', 'subtitle', 'header'],
        icon: Heading2,
        run: ({ editor, range }) => {
            editor.chain().focus().deleteRange(range).toggleHeading({ level: 2 }).run()
        },
    },
    {
        id: 'heading-3',
        label: 'Heading 3',
        keywords: ['h3', 'subheader', 'header'],
        icon: Heading3,
        run: ({ editor, range }) => {
            editor.chain().focus().deleteRange(range).toggleHeading({ level: 3 }).run()
        },
    },
    {
        id: 'bullet-list',
        label: 'Bullet list',
        keywords: ['ul', 'unordered', 'list'],
        icon: List,
        run: ({ editor, range }) => {
            editor.chain().focus().deleteRange(range).toggleBulletList().run()
        },
    },
    {
        id: 'numbered-list',
        label: 'Numbered list',
        keywords: ['ol', 'ordered', 'numbered', 'list'],
        icon: ListOrdered,
        run: ({ editor, range }) => {
            editor.chain().focus().deleteRange(range).toggleOrderedList().run()
        },
    },
    {
        id: 'quote',
        label: 'Quote',
        keywords: ['blockquote', 'citation'],
        icon: Quote,
        run: ({ editor, range }) => {
            editor.chain().focus().deleteRange(range).toggleBlockquote().run()
        },
    },
    {
        id: 'code-block',
        label: 'Code block',
        keywords: ['code', 'codeblock', 'snippet', 'pre'],
        icon: Code2,
        run: ({ editor, range }) => {
            editor.chain().focus().deleteRange(range).toggleCodeBlock().run()
        },
    },
    {
        id: 'table',
        label: 'Table',
        keywords: ['grid', 'rows', 'columns'],
        icon: TableIcon,
        run: ({ editor, range }) => {
            editor
                .chain()
                .focus()
                .deleteRange(range)
                .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                .run()
        },
    },
    {
        id: 'image',
        label: 'Image',
        keywords: ['picture', 'photo', 'img'],
        icon: ImageIcon,
        // Image picking happens outside the editor (file picker, URL
        // prompt, drive upload). We delete the slash trigger here and
        // delegate to the host-supplied `openImageInsert` callback so
        // the screen can run its existing image-insert flow.
        run: ({ editor, range, openImageInsert }) => {
            editor.chain().focus().deleteRange(range).run()
            openImageInsert?.()
        },
    },
    {
        id: 'horizontal-rule',
        label: 'Horizontal rule',
        keywords: ['hr', 'divider', 'separator', 'line'],
        icon: Minus,
        run: ({ editor, range }) => {
            editor.chain().focus().deleteRange(range).setHorizontalRule().run()
        },
    },
]

// Case-insensitive substring filter over label + keywords. Empty /
// whitespace-only queries return the full list in stable order so the
// menu shows the canonical entry order the moment the user types `/`.
export function filterSlashMenuCommands(
    query: string,
    commands: SlashMenuCommand[] = SLASH_MENU_COMMANDS
): SlashMenuCommand[] {
    const q = query.trim().toLowerCase()
    if (!q) return commands.slice()
    return commands.filter(cmd => {
        if (cmd.label.toLowerCase().includes(q)) return true
        return cmd.keywords.some(kw => kw.toLowerCase().includes(q))
    })
}
