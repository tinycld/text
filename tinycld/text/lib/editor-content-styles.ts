// CSS rules that style the ProseMirror content area for the document
// editor. Shared by the web in-page editor (use-document-editor.web.tsx)
// and the WebView editor used on native (webview-editor/source/styles.ts).
//
// Why this exists: Tailwind/Uniwind preflight strips browser defaults
// from headings, lists, links, blockquotes, and tables. Without these
// rules, an imported .docx renders as a flat wall of 14px text — no
// heading hierarchy, no bullets/numbers, no link styling. These rules
// put the document semantics back.
//
// Colors come from CSS custom properties so light/dark mode works on
// the web side. The host (web or WebView entry) is responsible for
// setting the variables before rules are applied:
//
//   --editor-foreground:    body text color
//   --editor-muted:         secondary text (blockquote, captions)
//   --editor-border:        table/blockquote borders
//   --editor-link:          hyperlink color
//   --editor-placeholder:   placeholder text when empty
//
// On the web side these are set via inline style on the wrapper, fed
// from useThemeColor(). The WebView is light-mode only today and
// supplies hardcoded fallbacks at the :root level.
export const EDITOR_CONTENT_STYLES = `
.ProseMirror {
    outline: none;
    min-height: 200px;
    color: var(--editor-foreground, #1a1a1a);
    /* 15px is visually equivalent to Word's 11pt body size; declaring
       11pt directly is correct in CSS but browsers compute it to
       14.667px, which renders blurrier than a whole-pixel size. */
    font: 15px / 1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    /* Cap the content area at roughly a US Letter page's usable width
       (8.5in - 2*1in margins = 6.5in, ≈ 624px at 96dpi, plus a small
       fudge for breathing room) and center it. This is the same choice
       Google Docs / Notion / Word's "Web Layout" make: tables, images,
       and lines of text render at the same proportions a Word user sees
       on a printed page, instead of stretching to fill the editor pane.
       Tables imported from .docx use absolute dxa widths, so anchoring
       the surrounding canvas to a page-equivalent width is what makes
       those widths look right. */
    max-width: 680px;
    width: 100%;
    margin-left: auto;
    margin-right: auto;
}
.ProseMirror p {
    margin: 0 0 0.75em 0;
}
.ProseMirror h1 {
    font-size: 2em;
    font-weight: 700;
    line-height: 1.2;
    margin: 0.67em 0 0.4em;
}
.ProseMirror h2 {
    font-size: 1.5em;
    font-weight: 700;
    line-height: 1.25;
    margin: 0.8em 0 0.4em;
}
.ProseMirror h3 {
    font-size: 1.17em;
    font-weight: 700;
    line-height: 1.3;
    margin: 0.8em 0 0.4em;
}
.ProseMirror h4 {
    font-size: 1em;
    font-weight: 700;
    margin: 1em 0 0.4em;
}
.ProseMirror h5 {
    font-size: 0.9em;
    font-weight: 700;
    margin: 1em 0 0.4em;
}
.ProseMirror h6 {
    font-size: 0.8em;
    font-weight: 700;
    margin: 1em 0 0.4em;
}
.ProseMirror blockquote {
    border-left: 3px solid var(--editor-border, #ccc);
    margin: 0 0 0.75em 0;
    padding-left: 1em;
    color: var(--editor-muted, #555);
}
.ProseMirror ul,
.ProseMirror ol {
    padding-left: 2.5em;
    margin: 0 0 0.75em 0;
}
/* Nested lists indent further (Word's default abstractNum
   adds ~0.25" / 360 twips per level over the parent). */
.ProseMirror li > ul,
.ProseMirror li > ol {
    padding-left: 2em;
    margin: 0;
}
.ProseMirror ul {
    list-style: disc;
}
.ProseMirror ol {
    list-style: decimal;
}
.ProseMirror ul ul {
    list-style: circle;
}
.ProseMirror ul ul ul {
    list-style: square;
}
.ProseMirror li {
    display: list-item;
    margin: 0.15em 0;
}
.ProseMirror li > p {
    margin: 0;
}
.ProseMirror a {
    color: var(--editor-link, #1d4ed8);
    text-decoration: underline;
}
.ProseMirror table {
    border-collapse: collapse;
    margin: 0 0 0.75em 0;
    /* TipTap's TableView writes inline style.width from the summed
       per-cell colwidth attributes (one entry per column) and inserts
       a <colgroup> sized to match. Tables imported from .docx carry
       their original column widths through that pipeline, so we let
       the inline style win instead of forcing every table to 100%
       width. Tables authored in the editor without explicit widths
       still get a sensible auto-layout via the TableView fallback. */
    table-layout: fixed;
}
.ProseMirror th,
.ProseMirror td {
    border: 1px solid var(--editor-border, #ddd);
    padding: 6px 8px;
    text-align: left;
    vertical-align: top;
}
.ProseMirror th {
    background: var(--editor-table-header, #f3f4f6);
    font-weight: 600;
}
.ProseMirror img {
    max-width: 100%;
    height: auto;
    display: block;
    margin: 0.5em 0;
}
.ProseMirror img[data-wrap='left'] {
    float: left;
    display: inline;
    margin: 0.25em 1em 0.5em 0;
    max-width: 50%;
}
.ProseMirror img[data-wrap='right'] {
    float: right;
    display: inline;
    margin: 0.25em 0 0.5em 1em;
    max-width: 50%;
}
.ProseMirror h1,
.ProseMirror h2,
.ProseMirror h3,
.ProseMirror h4,
.ProseMirror h5,
.ProseMirror h6,
.ProseMirror table {
    clear: both;
}
.ProseMirror.is-editor-empty:first-child::before {
    content: attr(data-placeholder);
    color: var(--editor-placeholder, #999);
    pointer-events: none;
    float: left;
    height: 0;
}
`
