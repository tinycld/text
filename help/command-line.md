---
title: Text from the command line
summary: Read, answer, and resolve document comments from a terminal with the tinycld CLI.
tags: [cli, terminal, automation, comments, review]
order: 190
---

The `tinycld` command line tool includes a `text` command group when the Text
package is installed. To download the tool and log in, see
[Command line tool](help://core:command-line). Everything below assumes you
are logged in.

## What the command group covers

Comments, and only comments. Your documents are Drive files, so everything
else you might want from a terminal is already a `drive` command:

```
tinycld drive put notes.md /            # create a document
tinycld drive ls /                      # list your documents
tinycld drive get /Plan.md .            # download one
tinycld drive rm /Plan.md               # delete one
```

The document body itself is edited in the collaborative editor and is not
written from a shell — a terminal write would clobber whatever anyone else
was typing.

## Reading comments

```
tinycld text comments /Plan.md          # open threads
tinycld text comments /Plan.md --all    # include resolved and archived
```

`<path>` is a Drive path or `id:<record id>`, the same references `tinycld
drive` accepts.

Resolved threads are hidden by default so what is left is what still needs an
answer; the count of hidden comments is reported so nothing disappears
silently. Replies are shown indented under the comment they answer, and the
`ON` column shows the document text a comment is anchored to.

An **archived** comment is one whose anchor text was deleted from the
document. It is kept as history and shown only with `--all`.

## Adding and answering

```
tinycld text comments /Plan.md --add "This section needs a rewrite"
tinycld text comments /Plan.md --add "Agreed" --reply-to cmt123
tinycld text comments /Plan.md --add "Check this" --quote "the second paragraph"
```

`--quote` records which part of the document you are talking about, the way
selecting text does in the app. Replies are one level deep: replying to a
reply attaches your comment to the same thread.

## Resolving

```
tinycld text comments /Plan.md --resolve cmt123
tinycld text comments /Plan.md --reopen cmt123
```

Resolving applies to the whole thread, so it does not matter whether you name
the original comment or one of its replies.

See [Comments on mobile](help://text:comments-on-mobile) for how the same
threads behave in the app.

## Scripting

Every command accepts `--json` for stable, machine-readable output, and the
full comment body survives into it even though the table shows one line:

```
tinycld text comments /Plan.md --json | jq '.[].body'
tinycld text comments /Plan.md --json | jq -r '.[] | select(.parent_comment == "") | .id'
```
