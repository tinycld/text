import { Extension } from '@tiptap/core'

// Shared helpers between the WebView's Editor.tsx and the web variant
// (use-document-editor.web.tsx). These are pure, editor-only deriving
// functions that read attributes off whatever Tiptap editor is passed
// in — so they're easy to unit-test against a stubbed editor and
// trivially shareable between the two mounting paths.
//
// The historical location was inside use-document-editor.web.tsx; we
// hoist them here so the WebView entry can load them without dragging
// in the rest of the web hook (drive uploads, theme tokens, slash
// menu, etc.). The WebView and web variants of the same package MUST
// derive identical state so the toolbar lights up consistently.

// EditorLike: the minimum surface the helpers need. Matches both
// `Editor` from @tiptap/react and the return of `useEditor` (which is
// `Editor | null` plus stable identity). Kept structural so tests can
// pass a minimal stub without depending on the heavy Tiptap React
// surface.
export interface EditorLike {
    getAttributes(typeOrName: string): Record<string, unknown>
    isActive(name: string, attrs?: Record<string, unknown>): boolean
}

export type AlignValue = 'left' | 'center' | 'right' | 'justify' | null

// deriveCurrentAlign reads the textAlign attr off whichever indentable
// block the caret is in (paragraph or heading). Returns null when no
// attr is set — the schema default is "left", which we deliberately
// represent as the absence of an attr (matches the DOCX exporter,
// which emits <w:jc> only for non-left values). The toolbar's "Left"
// button uses null as the highlight condition so it appears active by
// default and disengages whenever another alignment is set.
export function deriveCurrentAlign(editor: EditorLike | null | undefined): AlignValue {
    if (!editor) return null
    const fromPara = editor.getAttributes('paragraph')?.textAlign
    const fromHeading = editor.getAttributes('heading')?.textAlign
    const v = fromPara || fromHeading
    if (v === 'center' || v === 'right' || v === 'justify') return v
    if (v === 'left') return 'left'
    return null
}

// deriveCurrentFontSize reads the textStyle.fontSize attr at the caret
// and returns the integer px value, or null when no fontSize is set
// (document default). The Tiptap FontSize extension stores the
// attribute as a CSS length string ("16px"); we parse the integer
// out for the toolbar dropdown. Bare numbers and trailing-unit
// variants ("14") are tolerated for robustness when pasting from
// other sources.
export function deriveCurrentFontSize(editor: EditorLike | null | undefined): number | null {
    if (!editor) return null
    const raw = editor.getAttributes('textStyle')?.fontSize
    if (typeof raw !== 'string' || raw === '') return null
    const trimmed = raw.trim().toLowerCase()
    const numeric = trimmed.endsWith('px') ? trimmed.slice(0, -2).trim() : trimmed
    const n = Number.parseFloat(numeric)
    if (!Number.isFinite(n) || n <= 0) return null
    return Math.round(n)
}

// deriveCurrentFontFamily returns the textStyle.fontFamily attr at the
// caret (already a string in the schema), or null when no family is
// set. Empty strings collapse to null so the toolbar shows "Default"
// rather than a blank selected state.
export function deriveCurrentFontFamily(editor: EditorLike | null | undefined): string | null {
    if (!editor) return null
    const raw = editor.getAttributes('textStyle')?.fontFamily
    if (typeof raw !== 'string' || raw === '') return null
    return raw
}

// deriveActiveIndent returns the integer indent attr of the active
// paragraph/heading, clamped non-negative. Returns 0 when the caret
// is not in an indentable block, which keeps canOutdent=false there
// (the buttons should appear disabled, not crash).
export function deriveActiveIndent(editor: EditorLike | null | undefined): number {
    if (!editor) return 0
    const paraAttrs = editor.getAttributes('paragraph')
    const headingAttrs = editor.getAttributes('heading')
    const raw =
        typeof paraAttrs?.indent === 'number'
            ? paraAttrs.indent
            : typeof headingAttrs?.indent === 'number'
              ? headingAttrs.indent
              : 0
    if (!Number.isFinite(raw) || raw < 0) return 0
    return raw
}

// deriveActiveHeadingLevel scans h1..h6 and returns the level of the
// active heading at the caret, or null when none is active. The
// toolbar's heading dropdown uses this to highlight the right level
// (or "Paragraph" when null). Kept as a named helper so it's reusable
// across the WebView Editor and the web variant, and trivially unit-
// testable against an EditorLike stub.
export function deriveActiveHeadingLevel(
    editor: EditorLike | null | undefined
): number | null {
    if (!editor) return null
    for (let level = 1; level <= 6; level++) {
        if (editor.isActive('heading', { level })) return level
    }
    return null
}

// CodeShortcuts overrides the StarterKit-bundled keymaps for inline
// `code` and `codeBlock` to the Markdown-style backtick shortcuts.
//   - Mod-` toggles the inline code mark (StarterKit default: Mod-e).
//   - Mod-Shift-` toggles the code block node (StarterKit default:
//     Mod-Alt-c).
// We register on a separate extension so the override is purely
// additive — Tiptap merges multiple extensions' keymaps, so the
// StarterKit defaults still work alongside our additions. The Mod-e
// default is retained for users coming from other Tiptap apps.
export const CodeShortcuts = Extension.create({
    name: 'tinycldCodeShortcuts',
    addKeyboardShortcuts() {
        return {
            'Mod-`': () => this.editor.commands.toggleCode(),
            'Mod-Shift-`': () => this.editor.commands.toggleCodeBlock(),
        }
    },
})
