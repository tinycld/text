import { PRINT_CSS } from './print-css'

// renderPrintHtml wraps the editor's serialized HTML body in a
// self-contained document the browser (or expo-print) can print
// directly.
//
// Pure function — output is deterministic for a given input, so unit
// tests snapshot the string.
//
// Asset constraint: the output must reference no external assets
// (no <link>, no @font-face, no remote url()). iOS expo-print doesn't
// bundle them. Inline <img src="data:..."> images embedded by the
// editor are fine because the data lives in the document itself.
//
// The `editor.getHTML()` output is already escaped by ProseMirror's
// HTML serializer, so we don't re-escape it here.
export function renderPrintHtml(body: string): string {
    return [
        '<!doctype html>',
        '<html lang="en">',
        '<head>',
        '<meta charset="utf-8">',
        '<title>Print</title>',
        '<style>',
        PRINT_CSS,
        '</style>',
        '</head>',
        '<body>',
        '<article class="print-document">',
        body,
        '</article>',
        '</body>',
        '</html>',
    ].join('\n')
}
