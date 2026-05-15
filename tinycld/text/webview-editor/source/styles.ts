// Editor stylesheet kept as a TS string constant. Inlined at runtime
// via a <style> tag injection rather than going through a CSS loader
// in esbuild — avoids needing a separate pipeline step just for this
// one stylesheet and keeps the bundle a single .js artifact that the
// existing scriptTagPattern inliner handles unchanged.
export const STYLES = `
html, body {
    margin: 0;
    padding: 0;
    height: 100%;
    -webkit-user-select: text;
    -webkit-tap-highlight-color: transparent;
}
body {
    font: 14px / 1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: #1a1a1a;
    background: #fff;
}
#root {
    padding: 16px;
    min-height: 100%;
    box-sizing: border-box;
}
.ProseMirror {
    outline: none;
    min-height: 200px;
}
.ProseMirror p { margin: 0 0 0.75em 0; }
.ProseMirror h1 { font-size: 24px; margin: 0.5em 0; }
.ProseMirror h2 { font-size: 20px; margin: 0.5em 0; }
.ProseMirror h3 { font-size: 16px; margin: 0.5em 0; }
.ProseMirror blockquote {
    border-left: 3px solid #ccc;
    margin: 0 0 0.75em 0;
    padding-left: 1em;
    color: #555;
}
.ProseMirror ul, .ProseMirror ol {
    padding-left: 1.5em;
    margin: 0 0 0.75em 0;
}
.ProseMirror a {
    color: #1d4ed8;
    text-decoration: underline;
}
.ProseMirror table {
    border-collapse: collapse;
    margin: 0 0 0.75em 0;
    width: 100%;
}
.ProseMirror th, .ProseMirror td {
    border: 1px solid #ddd;
    padding: 6px 8px;
    text-align: left;
}
.ProseMirror img { max-width: 100%; height: auto; }
.ProseMirror.is-editor-empty:first-child::before {
    content: attr(data-placeholder);
    color: #999;
    pointer-events: none;
    float: left;
    height: 0;
}
/* CollaborationCaret styles - peers' cursors and labels */
.collaboration-cursor__caret {
    border-left: 2px solid;
    border-right: 2px solid;
    margin-left: -1px;
    margin-right: -1px;
    pointer-events: none;
    position: relative;
    word-break: normal;
}
.collaboration-cursor__label {
    border-radius: 3px 3px 3px 0;
    color: white;
    font-size: 11px;
    font-style: normal;
    font-weight: 600;
    left: -2px;
    line-height: normal;
    padding: 1px 4px;
    position: absolute;
    top: -18px;
    user-select: none;
    white-space: nowrap;
}
`
