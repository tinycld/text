// Package cli contributes the `tinycld text` command group.
//
// The group is deliberately SMALL, and the reason is worth stating so nobody
// "completes" it by mistake:
//
//   - A DOCUMENT IS A DRIVE ITEM. text owns the comments on documents and
//     nothing else — the documents themselves live in drive_items, which
//     `tinycld drive` already lists, uploads, downloads, moves, and deletes.
//     A `text new` here would be a second code path creating drive items,
//     duplicating what drive/cli already owns and tests. Create a document
//     with `tinycld drive put`.
//
//   - THE EDITOR IS NOT SCRIPTABLE. A text document's body is a Yjs CRDT
//     state, edited through the collaborative editor. There is no meaningful
//     "write the body from a shell" operation that would not corrupt or
//     clobber concurrent edits, so none is offered. `tinycld drive cat` reads
//     the stored file.
//
// What is left — and what people actually want from a terminal — is the
// comment surface: seeing what has been asked on a document, answering, and
// resolving. That is this package.
//
// Comments reach their document through `drive_item`, and the access rules
// admit only its creator or someone it is shared with. So a useful token holds
// drive:read as well as text:read; text:* governs the comment collection
// itself, not the documents.
package cli

import (
	"github.com/spf13/cobra"

	"tinycld.org/cli/client"
)

func Register(root *cobra.Command, c *client.Client) {
	text := &cobra.Command{
		Use:   "text",
		Short: "Documents: read and answer comments",
		Long: "Comments on your text documents.\n\n" +
			"The documents themselves are Drive files — use `tinycld drive` to\n" +
			"create, list, download, and delete them.",
	}
	text.AddCommand(newCommentsCmd(c))
	root.AddCommand(text)
}
