// preview-css.ts is the styling layer for the text preview surface.
// The server emits stable `tinycld-doc*` class names; this file
// turns those into a theme-aware visual treatment for the read-only
// preview iframe.
//
// The iframe is sandboxed (no scripts, same-origin) so we cannot pull
// theme tokens from the parent. We embed both light and dark palettes
// and switch via `@media (prefers-color-scheme)` — the OS-level
// preference closely matches what the app would pick anyway, and the
// preview is short-lived enough that drift between the two is
// uninteresting.
//
// Class vocabulary documented at server/translate/pm_to_html.go.
//
// Design intent: "Google-Docs-readable in either theme." Sane line
// length, comfortable line height, no decorative chrome. Inline marks
// (bold/italic/etc.) carry their own class so we can target them
// regardless of which tiptap node they're attached to.
export const PREVIEW_CSS = `
:root {
    color-scheme: light dark;
    --tc-fg: #18181b;
    --tc-bg: #ffffff;
    --tc-muted: #71717a;
    --tc-border: #e4e4e7;
    --tc-quote-bar: #d4d4d8;
    --tc-code-bg: #f4f4f5;
    --tc-table-header-bg: #fafafa;
    --tc-link: #2563eb;
    --tc-comment-bg: rgba(250, 204, 21, 0.25);
}
@media (prefers-color-scheme: dark) {
    :root {
        --tc-fg: #fafafa;
        --tc-bg: #09090b;
        --tc-muted: #a1a1aa;
        --tc-border: #27272a;
        --tc-quote-bar: #3f3f46;
        --tc-code-bg: #18181b;
        --tc-table-header-bg: #18181b;
        --tc-link: #60a5fa;
        --tc-comment-bg: rgba(250, 204, 21, 0.18);
    }
}
html, body { margin: 0; padding: 0; }
body {
    font-family: -apple-system, system-ui, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px;
    line-height: 1.55;
    color: var(--tc-fg);
    background: var(--tc-bg);
}
.tinycld-doc {
    max-width: 760px;
    margin: 0 auto;
    padding: 24px 32px;
}
.tinycld-doc-p {
    margin: 0 0 0.75em 0;
}
.tinycld-doc-h1, .tinycld-doc-h2, .tinycld-doc-h3,
.tinycld-doc-h4, .tinycld-doc-h5, .tinycld-doc-h6 {
    margin: 1.2em 0 0.4em 0;
    font-weight: 700;
    line-height: 1.25;
}
.tinycld-doc-h1 { font-size: 1.9em; }
.tinycld-doc-h2 { font-size: 1.55em; }
.tinycld-doc-h3 { font-size: 1.3em; }
.tinycld-doc-h4 { font-size: 1.15em; }
.tinycld-doc-h5 { font-size: 1em; }
.tinycld-doc-h6 { font-size: 0.9em; text-transform: uppercase; letter-spacing: 0.04em; }
.tinycld-doc-align--left { text-align: left; }
.tinycld-doc-align--center { text-align: center; }
.tinycld-doc-align--right { text-align: right; }
.tinycld-doc-align--justify { text-align: justify; }
.tinycld-doc-indent--1 { padding-left: 36px; }
.tinycld-doc-indent--2 { padding-left: 72px; }
.tinycld-doc-indent--3 { padding-left: 108px; }
.tinycld-doc-indent--4 { padding-left: 144px; }
.tinycld-doc-indent--5 { padding-left: 180px; }
.tinycld-doc-indent--6 { padding-left: 216px; }
.tinycld-doc-indent--7 { padding-left: 252px; }
.tinycld-doc-indent--8 { padding-left: 288px; }
.tinycld-doc-blockquote {
    border-left: 4px solid var(--tc-quote-bar);
    padding: 0.25em 0 0.25em 1em;
    margin: 0 0 0.75em 0;
    color: var(--tc-muted);
}
.tinycld-doc-pre {
    background: var(--tc-code-bg);
    border-radius: 6px;
    padding: 12px 14px;
    margin: 0 0 0.75em 0;
    overflow-x: auto;
}
.tinycld-doc-code-block,
.tinycld-doc-mark--code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.9em;
}
.tinycld-doc-mark--code {
    background: var(--tc-code-bg);
    padding: 1px 5px;
    border-radius: 3px;
}
.tinycld-doc-ul, .tinycld-doc-ol {
    margin: 0 0 0.75em 0;
    padding-left: 1.6em;
}
.tinycld-doc-li {
    margin: 0.15em 0;
}
.tinycld-doc-li > .tinycld-doc-p {
    margin: 0;
}
.tinycld-doc-hr {
    border: none;
    border-top: 1px solid var(--tc-border);
    margin: 1em 0;
}
.tinycld-doc-table {
    border-collapse: collapse;
    margin: 0 0 0.75em 0;
    width: 100%;
    table-layout: auto;
}
.tinycld-doc-tr {
    border: none;
}
.tinycld-doc-th, .tinycld-doc-td {
    border: 1px solid var(--tc-border);
    padding: 6px 10px;
    vertical-align: top;
    text-align: left;
}
.tinycld-doc-th {
    background: var(--tc-table-header-bg);
    font-weight: 600;
}
.tinycld-doc-img {
    max-width: 100%;
    height: auto;
}
.tinycld-doc-img-wrap--left {
    float: left;
    margin: 0.25em 1em 0.5em 0;
}
.tinycld-doc-img-wrap--right {
    float: right;
    margin: 0.25em 0 0.5em 1em;
}
.tinycld-doc-img-wrap--break {
    display: block;
    clear: both;
    margin: 0.5em 0;
}
.tinycld-doc-mark--bold { font-weight: 700; }
.tinycld-doc-mark--italic { font-style: italic; }
.tinycld-doc-mark--underline { text-decoration: underline; }
.tinycld-doc-mark--strike { text-decoration: line-through; }
.tinycld-doc-mark--link {
    color: var(--tc-link);
    text-decoration: underline;
}
.tinycld-doc-mark--comment {
    background: var(--tc-comment-bg);
    border-bottom: 1px dashed var(--tc-muted);
    padding: 0 1px;
}
.tinycld-doc-mark--text-style {
    /* base style; data-* selectors below project the run's font
     * properties via attribute-targeted rules so the renderer can
     * surface attrs without inline style= (which the sanitizer
     * strips). */
}
.tinycld-doc-footnote-ref, .tinycld-doc-endnote-ref {
    font-size: 0.75em;
    color: var(--tc-muted);
    margin-left: 1px;
}
`
