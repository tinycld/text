---
title: Inserting and resizing images
summary: Add pictures to a document and drag them to the size you want
tags: [images, picture, resize, insert]
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
