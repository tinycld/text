// CSS for the print HTML document. The selectors target the raw
// element types (p, h1, table, ...) emitted by `editor.getHTML()` —
// no `.ProseMirror` wrapper survives that serialization.
//
// Cell-border styles already ride inline on `<td>` / `<th>` via the
// BorderedTableCell extension (data-borders + style="border-top:..."),
// so we don't need a per-cell selector; the default table rule below
// gives all cells a thin gray edge, and per-cell inline borders win
// by CSS specificity.
export const PRINT_CSS = `
@page { size: portrait; margin: 0.75in; }
html, body { margin: 0; padding: 0; background: #fff; }
body {
    font-family: -apple-system, system-ui, 'Segoe UI', Roboto, sans-serif;
    font-size: 11pt;
    line-height: 1.4;
    color: #000;
}
.print-document {
    width: 100%;
}
.print-document p { margin: 0 0 0.5em 0; orphans: 3; widows: 3; }
.print-document h1 {
    font-size: 18pt;
    font-weight: 700;
    margin: 0.4em 0 0.3em;
    break-after: avoid;
}
.print-document h2 {
    font-size: 15pt;
    font-weight: 700;
    margin: 0.6em 0 0.3em;
    break-after: avoid;
}
.print-document h3 {
    font-size: 13pt;
    font-weight: 700;
    margin: 0.6em 0 0.3em;
    break-after: avoid;
}
.print-document h4,
.print-document h5,
.print-document h6 {
    font-size: 11pt;
    font-weight: 700;
    margin: 0.6em 0 0.3em;
    break-after: avoid;
}
.print-document ul,
.print-document ol {
    padding-left: 1.6em;
    margin: 0 0 0.5em 0;
}
.print-document li { margin: 0.1em 0; }
.print-document li > p { margin: 0; }
.print-document blockquote {
    border-left: 3px solid #888;
    padding-left: 0.75em;
    margin: 0 0 0.5em 0;
    color: #333;
}
.print-document a {
    color: #000;
    text-decoration: underline;
}
.print-document table {
    border-collapse: collapse;
    margin: 0 0 0.5em 0;
    table-layout: fixed;
    max-width: 100%;
}
.print-document th,
.print-document td {
    border: 1px solid #888;
    padding: 4px 6px;
    text-align: left;
    vertical-align: top;
}
.print-document th { background: #f0f0f0; font-weight: 700; }
.print-document img {
    max-width: 100%;
    height: auto;
}
.print-document tr,
.print-document h1,
.print-document h2,
.print-document h3,
.print-document h4,
.print-document blockquote,
.print-document figure,
.print-document table,
.print-document img {
    break-inside: avoid;
}
`
