---
title: Inserting, resizing, and wrapping images
summary: Add pictures to a document, drag them to size, and choose how text flows around them
tags: [images, picture, resize, insert, wrap, float, layout]
order: 60
---

## To insert an image

There are three ways to get an image into the document:

- **Toolbar button** — click the **image** icon. A file picker opens; choose a PNG, JPEG, GIF, or WebP file.
- **Slash menu** — type **/image** (see [the slash menu](help://text:slash-menu)), select it, then pick a file.
- **Paste or drop** — paste an image from your clipboard or drag an image file onto the editor.

Inserted images upload to your drive and the document references them by URL — they don't bloat the document's collaborative state with embedded base64 bytes.

## To resize an image

1. Click the image to select it. A blue outline appears with three drag handles.
2. Drag a handle:
   - **Right edge** — change width only.
   - **Bottom edge** — change height only.
   - **Bottom-right corner** — change both while keeping the aspect ratio.

Resize is bounded — minimum 32 × 32 px, maximum 800 px wide (the editor's content width) and 3200 px tall.

The new size persists to the document and round-trips through `.docx` via the image's `<wp:extent>` measurements, so a resize made here keeps its dimensions when opened in Word and vice versa.

> Note: Image resizing is available in the web editor. Mobile shows the image without resize handles for now.

## To change how text wraps around an image

When you select an image a small toolbar of four buttons appears just above it. Each button picks a different wrap mode — how the surrounding paragraph text relates to the image:

- **Inline** — the image sits in the text flow at its insertion point, like a giant letter. Text continues on the next line below it.
- **Wrap left** — the image floats to the left margin and text wraps around its right side.
- **Wrap right** — the image floats to the right margin and text wraps around its left side.
- **Break line** — the image takes its own line. Text never sits beside it, only above and below. This matches Word's "Top and Bottom" wrap.

The active mode highlights in the toolbar. Mode changes are independent of size — flipping the wrap mode doesn't reset width and height (and vice versa). Each mode round-trips through `.docx`, so a document opened in Word renders with the same layout.

A few interaction notes:

- A paragraph's alignment (left, center, right, justify) does not affect float behavior — a left-wrapped image stays at the paragraph's left edge regardless of `text-align`. This matches Word.
- Inside a narrow table cell, a wrapped image may consume the entire cell width. Use **Break line** if you want the image to keep the cell's full width and push text below.

> Note: The wrap toolbar is available in the web editor. Mobile renders wrap-moded images correctly but doesn't expose the toolbar yet — same asymmetry as resize handles.
