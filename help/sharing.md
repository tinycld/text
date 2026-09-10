---
title: Sharing a document
summary: Invite collaborators or hand out a link from inside the editor
tags: [share, permissions, collaboration, link]
order: 70
---

## Opening the share dialog

With a document open, choose **File → Share**. The same dialog you'd see in Drive opens — you don't have to leave the editor to invite people or generate a link.

## Adding teammates

Type a name or email in the **Add people** input. Matches from your team show up as you type. For each person you add, pick a role:

- **Viewer** — can open the document and read it. Cannot edit, rename, move, or re-share.
- **Editor** — can edit the document's contents, rename, move, and re-share.

Click **Send**. The document appears in their **Shared with me** section in Drive within seconds.

## Generating a public link

To share with someone without an account — or anyone outside your team — use **Get link**. The dialog generates a tokenized URL of the form `https://{{server-host}}/p/drive/share/<token>` that opens the document directly, no sign-in required. You choose what the link grants:

- **Viewer** — read-only, no comments, no sign-in.
- **Commentor** — read-only, but the visitor can leave comments after a one-time email verification (OTP).
- **Editor** — the visitor can edit after OTP verification. Their edits land in the same document everyone else sees.

Copy the URL and send it however you like. You can revoke or change the role any time from the same dialog.

## Changing or removing access

Each collaborator is listed below the input with their current role. Switch their role with the dropdown, or remove their access — the change takes effect immediately and the document disappears from their **Shared with me**.

## Who can see and post comments

Everyone with access to the document can read its comments, and the document's creator can always see and post comments even if they hold no share of their own. Suspended accounts are excluded from every comment operation, regardless of any share they were given while active.

## See also

- [Sharing files in Drive](help://drive:sharing)
- [Public share links](help://drive:public-links)
