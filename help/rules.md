---
title: Document rules
summary: React automatically when someone comments on a document
tags: [rules, automation, comments, workflow]
order: 90
---

Documents take part in [automation rules](help://core:rules) through comments.

## When a comment is added

The trigger **A comment is added to a document** fires whenever anyone
comments on a document you can see — not only when *you* comment. Everyone
with access to the document can build a rule on it, so the document's owner
hears about a colleague's comment, which is usually the point.

You can filter on the comment text, the quoted passage it's attached to, who
wrote it, and which document it's on.

Pair it with an action from another package — a notification, a calendar
reminder to follow up, a card on a board.

## Recipes

**Keep an eye on a specific document.** When a comment is added, if the
document is a particular one, send yourself a notification. Useful for a spec
or a contract you want to track without watching it.

**Catch questions.** When a comment is added, if the comment contains a
question mark, notify yourself.

## Mentions are separate

If you only want to hear when someone actually addresses *you*, use drive's
**I'm mentioned in a comment** trigger instead — it fires on @-mentions across
documents, spreadsheets and files alike. This trigger is broader: every comment
on every document you can reach.

## Documents have no rule actions

Nothing a rule could write would show up in a document. The text itself is
stored as collaborative edit operations rather than as fields a rule can set,
so text contributes triggers only. A rule that starts from a comment can still
*do* anything the other installed packages offer.

## What rules can't do yet

- **Reacting to edits.** Rules see comments, not typing. Editing a document
  produces collaborative operations rather than record changes, so there's no
  "when this document changes" trigger.
- **Timing.** There's no way to say "if nobody has replied in two days" —
  rules react to things happening, not to time passing.
- **Replying.** A rule can notice a comment but cannot post one back.
