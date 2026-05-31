---
title: Suggesting changes
summary: Propose edits to a document without committing them, then review accept and reject decisions in one place
tags: [suggesting, review, track-changes, comments, collaboration]
order: 25
---

## What "Suggesting" mode does

Suggesting mode turns your edits into **proposals** instead of changes. Type, delete, paste, format, add or remove a table cell — none of it lands in the document until someone accepts it. Each suggestion is attributed to you, time-stamped, and shown inline so collaborators can see exactly what you're proposing.

You stay in your own document the whole time — there's no separate "review copy". Editing and Suggesting both edit the same file; the difference is whether your changes become part of the doc immediately or wait for a decision.

## Switching modes

The editor mode lives in the toolbar dropdown labeled **Editing**, **Suggesting**, or **Viewing**. Click it to switch.

- **Editing** — the default. Edits go straight into the document.
- **Suggesting** — every edit becomes a tracked suggestion. The dropdown lights up in the accent color so you can see at a glance that you're not editing normally.
- **Viewing** — read-only. Use this when you want to scroll without risking a stray keystroke.

Viewing is always available. Editing and Suggesting are only offered if your role on the document is **owner** or **editor** — viewer and commentor roles will only see Viewing in the dropdown.

## How suggestions look in the doc

| Kind of change | Inline appearance |
|---|---|
| Insertion | Underlined run in the author's color |
| Deletion | Strikethrough run in the author's color |
| Format change (bold, italic, size, …) | The new formatting plus a subtle author-color marker |
| Block change (heading level, list type, alignment) | The new block style plus a marker in the gutter |
| Table change (add / remove row or column) | The new shape, with the changed cells outlined |

Hover (or tap) any suggestion to see who proposed it and when. Clicking it focuses that suggestion in the [Review drawer](#the-review-drawer).

## The Review drawer

The drawer is the single place to act on suggestions. Open it from the **Review** button in the toolbar (look for the speech-bubble-with-a-checkmark icon).

It has three tabs:

### Suggestions

A list of every open suggestion in the document, top to bottom. Each row shows:

- The author's avatar in their color
- A preview of the change
- Per-row **Accept** and **Reject** buttons

At the top of the list:

- **Accept all** — accepts every open suggestion in one pass. Useful when you've reviewed them inline and just want to commit the lot.
- **Reject all** — rejects every open suggestion. Useful when you want to throw away a round of feedback.

Clicking a row scrolls the editor to that suggestion's range and highlights it. Press **ESC** to clear the highlight without resolving anything.

Orphaned suggestions — ones whose anchor was deleted out from under them — appear in a separate section at the bottom of the list so they don't get lost.

### Activity

A reverse-chronological feed of what's happened in the document:

- **Edit events** — 60-second windows of free typing, attributed to whoever wrote them. The window only closes after a quiet period, so a long burst of typing shows up as a single entry rather than one per keystroke.
- **Resolved suggestions** — every accept or reject decision, with who made it and when.

Edit events only record while someone besides the writer is in the room. A solo writer doesn't generate activity rows — the log exists to surface what collaborators are doing _for_ other collaborators, not to log your own session.

The Activity tab is web-only for now; on mobile the drawer shows just the Suggestions tab.

### Authorship

A per-author breakdown of who wrote how much of the doc, shown as horizontal bars.

The tab also holds the **Color text by author** toggle. Flip it on and every text run in the document paints in its author's color — handy for seeing at a glance whose section is whose, or for spotting passages with mixed authorship. Flip it back off to return to the normal black-on-white view; the underlying authorship data stays, so toggling has no cost.

Like Activity, this tab is web-only.

## Threaded discussion on a suggestion

Every suggestion can have a back-and-forth reply thread, separate from regular [comments](help://text:sharing). Click a suggestion in the drawer or in the doc to open its thread, then type a reply and press **Enter** to send.

Threads live until the suggestion is resolved — accepting or rejecting the suggestion drops its replies along with it, so the doc doesn't accumulate stale discussion.

## Accepting and rejecting

- **Accept** lands the change in the document, removes the suggestion mark, and records the decision in the Activity feed.
- **Reject** removes the suggestion without applying it, also recording the decision.

Either action is final from the doc's perspective — there's no "undo accept" button. But because everything is collaborative, **⌘Z** in the editor itself undoes your last accept or reject the same way it undoes a regular edit, as long as you do it before the next save.

Only owners and editors can accept or reject. Viewers and commentors see the drawer in read-only form: they can read suggestions and replies, but the Accept / Reject buttons don't appear.

## Round-trip with Word and other editors

Suggestions are stored in the document's `.docx` blob as standard `<w:ins>` / `<w:del>` tracked changes, plus tinycld's own markers for block and table edits. That means:

- Download a doc with open suggestions as `.docx` and open it in Word — the suggestions show up as tracked changes you can accept or reject there.
- Upload a `.docx` from Word that already has tracked changes — they come in as suggestions in tinycld, attributed to whoever the original author was where possible.

Markdown export drops suggestions silently (Markdown has no tracked-change concept) — use `.docx` if you need to hand the document off with its review state intact.

## Version snapshots

When you **File → Save version**, tinycld writes both the `.docx` blob _and_ the underlying Yjs snapshot to the version row. Restoring an earlier version brings back its suggestions and authorship metadata exactly — not just the visible text. See [Saving a version](help://text:save-version).
