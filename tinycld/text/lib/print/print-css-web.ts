// buildTextPrintCssWeb returns the body of a <style> block (no outer
// <style> tags). The print envelope embeds this between
// <head><style> and </style></head>, and the server-rendered
// fragment provides the `tinycld-doc*` class names this CSS targets.
//
// Web printing flow: the host browser fetches external images
// itself during print preview, so `images=url` would work too —
// but we still use `images=embed` from the print path because it
// keeps the web + native paths sharing one envelope. Either way,
// nothing here needs to strip remote assets.
export function buildTextPrintCssWeb(): string {
    return `
@page { size: portrait; margin: 0.75in; }
html, body { margin: 0; padding: 0; background: #fff; }
body {
    font-family: -apple-system, system-ui, 'Segoe UI', Roboto, sans-serif;
    font-size: 11pt;
    line-height: 1.4;
    color: #000;
}
.tinycld-doc {
    width: 100%;
}
.tinycld-doc-p {
    margin: 0 0 0.5em 0;
    orphans: 3;
    widows: 3;
}
.tinycld-doc-h1, .tinycld-doc-h2, .tinycld-doc-h3,
.tinycld-doc-h4, .tinycld-doc-h5, .tinycld-doc-h6 {
    font-weight: 700;
    margin: 0.6em 0 0.3em;
    break-after: avoid;
}
.tinycld-doc-h1 { font-size: 18pt; }
.tinycld-doc-h2 { font-size: 15pt; }
.tinycld-doc-h3 { font-size: 13pt; }
.tinycld-doc-h4,
.tinycld-doc-h5,
.tinycld-doc-h6 { font-size: 11pt; }
.tinycld-doc-align--left { text-align: left; }
.tinycld-doc-align--center { text-align: center; }
.tinycld-doc-align--right { text-align: right; }
.tinycld-doc-align--justify { text-align: justify; }
.tinycld-doc-indent--1 { padding-left: 0.4in; }
.tinycld-doc-indent--2 { padding-left: 0.8in; }
.tinycld-doc-indent--3 { padding-left: 1.2in; }
.tinycld-doc-indent--4 { padding-left: 1.6in; }
.tinycld-doc-indent--5 { padding-left: 2in; }
.tinycld-doc-indent--6 { padding-left: 2.4in; }
.tinycld-doc-indent--7 { padding-left: 2.8in; }
.tinycld-doc-indent--8 { padding-left: 3.2in; }
.tinycld-doc-ul,
.tinycld-doc-ol {
    padding-left: 1.6em;
    margin: 0 0 0.5em 0;
}
.tinycld-doc-li { margin: 0.1em 0; }
.tinycld-doc-li > .tinycld-doc-p { margin: 0; }
.tinycld-doc-blockquote {
    border-left: 3px solid #888;
    padding-left: 0.75em;
    margin: 0 0 0.5em 0;
    color: #333;
}
.tinycld-doc-pre {
    background: #f4f4f5;
    padding: 8px 10px;
    margin: 0 0 0.5em 0;
    border-radius: 4px;
}
.tinycld-doc-code-block,
.tinycld-doc-mark--code {
    font-family: 'Courier New', monospace;
    font-size: 0.9em;
}
.tinycld-doc-mark--code {
    background: #f4f4f5;
    padding: 0 4px;
    border-radius: 2px;
}
.tinycld-doc-mark--bold { font-weight: 700; }
.tinycld-doc-mark--italic { font-style: italic; }
.tinycld-doc-mark--underline { text-decoration: underline; }
.tinycld-doc-mark--strike { text-decoration: line-through; }
.tinycld-doc-mark--link {
    color: #000;
    text-decoration: underline;
}
.tinycld-doc-mark--comment {
    background: rgba(250, 204, 21, 0.18);
}
.tinycld-doc-table {
    border-collapse: collapse;
    margin: 0 0 0.5em 0;
    table-layout: fixed;
    max-width: 100%;
}
.tinycld-doc-th,
.tinycld-doc-td {
    border: 1px solid #888;
    padding: 4px 6px;
    text-align: left;
    vertical-align: top;
}
.tinycld-doc-th { background: #f0f0f0; font-weight: 700; }
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
.tinycld-doc-hr {
    border: none;
    border-top: 1px solid #ccc;
    margin: 1em 0;
    page-break-after: always;
    break-after: page;
}
.tinycld-doc-tr,
.tinycld-doc-h1,
.tinycld-doc-h2,
.tinycld-doc-h3,
.tinycld-doc-h4,
.tinycld-doc-blockquote,
.tinycld-doc-table,
.tinycld-doc-img,
.tinycld-doc-pre {
    break-inside: avoid;
}
`
}
