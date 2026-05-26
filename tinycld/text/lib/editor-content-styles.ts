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
/* Drop cap. The DropCap extension (lib/editor/drop-cap.ts) sets
   data-drop-cap="true" on a paragraph; ::first-letter enlarges and
   floats the leading glyph so the body text wraps around it over
   roughly three lines. font-size is tuned against the 15px/1.5 body:
   ~3.2em ≈ three line-heights tall. line-height:0.9 + the small top
   padding keep the cap's cap-height aligned with the first text line
   instead of riding above it. The server-render / print path uses the
   .tinycld-text-p-drop-cap class for the same effect (print-css-web.ts,
   pm_to_html.go). */
.ProseMirror p[data-drop-cap='true']::first-letter {
    float: left;
    font-size: 3.2em;
    line-height: 0.9;
    font-weight: 700;
    padding: 0.02em 0.08em 0 0;
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
    /* Anchors the absolutely-positioned .column-resize-handle (rendered
       by Tiptap's columnResizing plugin) to the cell's trailing edge.
       Without this, the handle escapes to the nearest positioned
       ancestor and the teal indicator appears at the page border. */
    position: relative;
    border: 1px solid var(--editor-border, #ddd);
    padding: 6px 8px;
    text-align: left;
    vertical-align: top;
}
.ProseMirror th {
    background: var(--editor-table-header, #f3f4f6);
    font-weight: 600;
}
/* Column resize affordance. Tiptap's columnResizing plugin renders a
   .column-resize-handle inside each cell on the trailing edge while
   hovering or dragging; it sets body.cursor via .resize-cursor while
   a drag is active. Tint with the brand primary so the handle is
   visible in both light and dark mode. The handle's width is set by
   Table.configure({ handleWidth }) on the JS side; the CSS only
   controls color + cursor. */
.ProseMirror .column-resize-handle {
    position: absolute;
    right: -2px;
    top: 0;
    bottom: -2px;
    width: 4px;
    background-color: var(--editor-primary-color, #14b8a6);
    pointer-events: none;
}
.ProseMirror.resize-cursor {
    cursor: col-resize;
}
/* TableView wraps each <table> in a .tableWrapper div so it can host
   the absolutely-positioned resize handle without escaping the cell.
   Make sure overflow scrolls horizontally on narrow viewports instead
   of clipping the handle. */
.ProseMirror .tableWrapper {
    overflow-x: auto;
    margin: 0 0 0.75em 0;
}
.ProseMirror .tableWrapper > table {
    margin: 0;
}
/* Multi-cell selection (CellSelection from prosemirror-tables). Drives
   the visual highlight when the user shift-drags across cells. Without
   this the selection is invisible and merge-cells UI feels broken. */
.ProseMirror .selectedCell {
    background-color: color-mix(in srgb, var(--editor-primary-color, #14b8a6) 18%, transparent);
}
.ProseMirror img {
    max-width: 100%;
    height: auto;
    display: block;
    margin: 0.5em 0;
}
/* The web editor renders images through ImageNodeView, which wraps the
   img in a [data-node-view-wrapper] span and copies the wrap attr onto
   it as data-wrap. Float the WRAPPER (not the img) — text only wraps
   around a floated direct child of the paragraph. Sizing comes from
   the inline width/height the NodeView sets on the wrapper, so the
   cap below is just a safety net for oversized fixtures. */
.ProseMirror [data-node-view-wrapper][data-wrap='left'] {
    float: left;
    margin: 0.25em 1em 0.5em 0;
    max-width: 50%;
}
.ProseMirror [data-node-view-wrapper][data-wrap='right'] {
    float: right;
    margin: 0.25em 0 0.5em 1em;
    max-width: 50%;
}
/* Break mode (Word's "Top and Bottom"): the image takes its own line,
   floats above are cleared, text below resumes on a fresh row. Centered
   horizontally via auto margins so users who pick break mode get the
   centered layout Word writers expect. */
.ProseMirror [data-node-view-wrapper][data-wrap='break'] {
    display: block;
    float: none;
    clear: both;
    margin: 0.75em auto;
    max-width: 100%;
}
/* Legacy selectors for the native WebView editor, which still renders
   images as bare <img>s with data-wrap on the element itself (no
   NodeView wrapping). Keep these in sync with the wrapper rules above
   so behavior on native matches the web. */
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
.ProseMirror img[data-wrap='break'] {
    display: block;
    float: none;
    clear: both;
    margin: 0.75em auto;
    max-width: 100%;
}
/* Block-level / break-mode elements clear preceding floats. The break-mode
   image is in this list because it should never sit beside a float — that's
   the contract of Word's "Top and Bottom" mode. */
.ProseMirror h1,
.ProseMirror h2,
.ProseMirror h3,
.ProseMirror h4,
.ProseMirror h5,
.ProseMirror h6,
.ProseMirror table,
.ProseMirror [data-node-view-wrapper][data-wrap='break'],
.ProseMirror img[data-wrap='break'] {
    clear: both;
}
/* Inline code mark. A subtle monospace span with a muted background,
   matching the GitHub / Discord render of <code> in prose. Border
   radius keeps the corners tidy when the run sits mid-sentence. */
.ProseMirror code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
    font-size: 0.9em;
    padding: 1px 4px;
    border-radius: 3px;
    background-color: var(--editor-code-bg, rgba(127, 127, 127, 0.15));
}
/* Code block. Tiptap renders this as <pre><code>; the <code> child
   sits inside a block-level <pre> so we reset the inline padding /
   background above and apply the block presentation here. white-
   space: pre-wrap keeps long lines from forcing horizontal scroll
   while still preserving authored indentation and line breaks. */
.ProseMirror pre {
    margin: 0 0 0.75em 0;
    padding: 12px;
    border-radius: 6px;
    background-color: var(--editor-code-bg, rgba(127, 127, 127, 0.15));
    overflow-x: auto;
}
.ProseMirror pre code {
    display: block;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
    font-size: 0.9em;
    padding: 0;
    background: transparent;
    border-radius: 0;
    white-space: pre-wrap;
    word-break: break-word;
}
.ProseMirror.is-editor-empty:first-child::before {
    content: attr(data-placeholder);
    color: var(--editor-placeholder, #999);
    pointer-events: none;
    float: left;
    height: 0;
}
/* Find/replace match highlighting. The find-replace plugin paints
   every match with .text-find-match and the currently focused match
   with .text-find-match-active. The colors are derived from theme
   tokens via CSS vars so light/dark mode tracks the rest of the UI. */
.ProseMirror .text-find-match {
    background-color: var(--editor-find-match, rgba(255, 213, 79, 0.45));
    border-radius: 2px;
}
.ProseMirror .text-find-match-active {
    background-color: var(--editor-find-match-active, rgba(255, 152, 0, 0.7));
    border-radius: 2px;
}
/* Comment marks. A subtle yellow underline keeps the anchored range
   visible without overwhelming the surrounding text. Hover paints a
   matching highlight so it's clear a click will target the mark. The
   span is inserted by the tinycldComment Mark with class
   .tinycld-comment. */
.ProseMirror .tinycld-comment {
    border-bottom: 2px solid var(--editor-comment-underline, rgba(250, 204, 21, 0.85));
    cursor: pointer;
}
.ProseMirror .tinycld-comment:hover {
    background-color: var(--editor-comment-highlight, rgba(250, 204, 21, 0.22));
}

/* ── Collaboration cursors (CollaborationCaret v3) ─────────────────────
   @tiptap/extension-collaboration-caret renames the v2 classes (plural
   "carets" + double-underscore). The extension injects:

     <span class="collaboration-carets__caret" style="border-color: $color">
         <div class="collaboration-carets__label" style="background-color: $color">
             $userName
         </div>
     </span>

   …and for a non-empty remote selection:

     <span class="ProseMirror-yjs-selection" style="background-color: $color70">…</span>

   Without these rules the caret span has no border-style so the inline
   border-color resolves to nothing visible — and the label <div>, being
   a block-level child of an inline span, balloons to fill the line.
   That's the "giant green block" footgun. */

/* Caret — a 2px vertical line that rides the line-height of the
   surrounding text. The extension sets border-color (user color) inline;
   we add the matching border-style: solid + border-width here. We
   deliberately set ONLY the left border (v2 used both, doubling the
   apparent thickness) and zero out the inline-box width so the line
   doesn't push surrounding glyphs sideways. position: relative anchors
   the absolutely-positioned label. */
.ProseMirror .collaboration-carets__caret {
    position: relative;
    display: inline-block;
    width: 0;
    margin-left: -1px;
    border-left-style: solid;
    border-left-width: 2px;
    pointer-events: none;
    word-break: normal;
    box-sizing: content-box;
    /* Letter-spacing zero keeps the 2px line from picking up word-break
       adjustments inside justified paragraphs. */
    letter-spacing: 0;
}

/* The label rides ABOVE the caret as a small pill, fully clear of the
   line of text the caret sits on — so the 2px caret line itself stays
   visible end-to-end (otherwise the label visually overlaps + hides
   the caret, defeating the whole point of the indicator).

   bottom: 100% anchors the label's bottom edge to the caret span's
   top edge (which equals the text line's top), and a 4px margin-bottom
   lifts the label off the line entirely. left: -2px compensates for
   the 2px caret border so the label and caret share a vertical edge.

   Background color is set inline by the extension to the user's
   palette color; we layer typography, radius, and a soft shadow on top.

   Animation: the label fades to 0 opacity ~2.5s after the caret span
   mounts. Yjs awareness re-mounts the decoration whenever the remote
   caret moves, so the fade restarts on every typing burst — matches
   the Notion/Confluence pattern of "show name on activity, hide once
   stable". Hovering the caret pauses & reverts the fade so a reader
   can identify a stationary collaborator at will. */
.ProseMirror .collaboration-carets__label {
    position: absolute;
    bottom: 100%;
    left: -2px;
    margin-bottom: 4px;
    z-index: 20;
    padding: 1px 6px 2px;
    border-radius: 4px 4px 4px 0;
    font: 600 11px/1.3 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    letter-spacing: 0.01em;
    color: #fff;
    white-space: nowrap;
    user-select: none;
    pointer-events: none;
    box-shadow:
        0 1px 2px rgba(0, 0, 0, 0.12),
        0 2px 6px rgba(0, 0, 0, 0.08);
    transform-origin: 0 100%;
    opacity: 1;
    animation: tinycld-caret-label-fade 2.6s ease-out 2s forwards;
}

/* Bring the label back when the reader hovers within ~24px of the
   caret. The hover surface is the caret span; widening its effective
   hit area via padding would push surrounding text, so we let the
   browser's default pointer hit-test the 2px line — coarse but
   sufficient for the recovery affordance. */
.ProseMirror .collaboration-carets__caret:hover .collaboration-carets__label {
    animation: none;
    opacity: 1;
    transform: scale(1);
}

@keyframes tinycld-caret-label-fade {
    0% {
        opacity: 1;
        transform: translateY(0) scale(1);
    }
    85% {
        opacity: 1;
        transform: translateY(0) scale(1);
    }
    100% {
        opacity: 0;
        transform: translateY(-2px) scale(0.92);
    }
}

/* Remote-user selection highlight. The extension paints a span with
   the user color at 44% alpha (#RRGGBB70) inline — that's already the
   right intensity. The CSS adds only a small border-radius so the run
   edges don't look like a cut-out rectangle when the selection wraps
   across a line break, and a hair of vertical padding so the highlight
   nestles around descenders. */
.ProseMirror .ProseMirror-yjs-selection {
    border-radius: 2px;
    padding-block: 1px;
}

/* ── Legacy CollaborationCursor (v2 class names) ───────────────────────
   Kept verbatim so any environment still pinning the v2 extension
   (the WebView build was at v2 for a release window) doesn't regress.
   Safe to delete once every consumer ships v3. */
.ProseMirror .collaboration-cursor__caret {
    position: relative;
    display: inline-block;
    width: 0;
    margin-left: -1px;
    border-left-style: solid;
    border-left-width: 2px;
    pointer-events: none;
    word-break: normal;
    box-sizing: content-box;
}
.ProseMirror .collaboration-cursor__label {
    position: absolute;
    bottom: 100%;
    left: -2px;
    margin-bottom: 4px;
    z-index: 20;
    padding: 1px 6px 2px;
    border-radius: 4px 4px 4px 0;
    font: 600 11px/1.3 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: #fff;
    white-space: nowrap;
    user-select: none;
    pointer-events: none;
    box-shadow:
        0 1px 2px rgba(0, 0, 0, 0.12),
        0 2px 6px rgba(0, 0, 0, 0.08);
}
`
