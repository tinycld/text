package cli

import (
	"context"
	"crypto/rand"
	"fmt"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"tinycld.org/cli/client"
	"tinycld.org/cli/output"
)

// anchorAlphabet matches PocketBase's own record-id alphabet, so a generated
// anchor is indistinguishable in shape from one the app produced.
const anchorAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789"

// newAnchorID mints a comment_id for a thread with no editor selection behind
// it. crypto/rand rather than math/rand: these ids are compared for equality
// across clients, and a seeded PRNG in a short-lived CLI process would repeat
// across invocations (two runs in the same second colliding would silently
// merge unrelated threads in the drawer).
func newAnchorID() string {
	b := make([]byte, 15)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand does not fail in practice; a time-based fallback keeps
		// the command working rather than refusing to post a comment.
		return fmt.Sprintf("cli%d", time.Now().UnixNano())
	}
	for i, v := range b {
		b[i] = anchorAlphabet[int(v)%len(anchorAlphabet)]
	}
	return string(b)
}

// newCommentsCmd is the whole command surface: list a document's comments,
// add one, reply to one, or resolve a thread.
//
// Flags rather than subcommands (`comments --add` over `comments add`) because
// every mode takes the same required argument — the document — and the reading
// mode is overwhelmingly the common one. `tinycld text comments <path>` with
// no flags is the thing people type.
func newCommentsCmd(c *client.Client) *cobra.Command {
	var (
		add      string
		replyTo  string
		resolve  string
		reopen   string
		showAll  bool
		quotedAt string
	)
	cmd := &cobra.Command{
		Use:   "comments <path>",
		Short: "Read, add, and resolve comments on a document",
		Long: "Read, add, and resolve comments on a document.\n\n" +
			"<path> is a Drive path (/Notes/Plan.md) or id:<record id>, the same\n" +
			"references `tinycld drive` accepts.\n\n" +
			"Resolved threads are hidden unless --all.",
		Args:    cobra.ExactArgs(1),
		Aliases: []string{"comment"},
		Example: "  tinycld text comments /Plan.md\n" +
			"  tinycld text comments /Plan.md --add \"Needs a rewrite\"\n" +
			"  tinycld text comments /Plan.md --reply-to cmt123 --add \"Agreed\"\n" +
			"  tinycld text comments /Plan.md --resolve cmt123",
		RunE: func(cmd *cobra.Command, args []string) error {
			o, _, err := output.FromCommand(cmd)
			if err != nil {
				return err
			}
			ctx := cmd.Context()

			// One action per invocation: combining them would make the output
			// ambiguous about what happened.
			if err := exactlyOneAction(cmd); err != nil {
				return err
			}

			doc, err := resolveDocument(ctx, c, args[0])
			if err != nil {
				return err
			}

			switch {
			case add != "":
				return addComment(cmd, c, o, doc, add, replyTo, quotedAt)
			case resolve != "":
				return setResolved(cmd, c, o, doc, resolve, true)
			case reopen != "":
				return setResolved(cmd, c, o, doc, reopen, false)
			default:
				return listComments(cmd, c, o, doc, showAll)
			}
		},
	}
	fl := cmd.Flags()
	fl.StringVar(&add, "add", "", "post a comment with this body")
	fl.StringVar(&replyTo, "reply-to", "", "reply to this comment id (with --add)")
	fl.StringVar(&quotedAt, "quote", "", "the document text this comment refers to (with --add)")
	fl.StringVar(&resolve, "resolve", "", "mark this thread resolved")
	fl.StringVar(&reopen, "reopen", "", "mark this thread unresolved")
	fl.BoolVar(&showAll, "all", false, "include resolved threads")
	cmd.MarkFlagsMutuallyExclusive("add", "resolve", "reopen")
	return cmd
}

// exactlyOneAction rejects flag combinations MarkFlagsMutuallyExclusive cannot
// express — a modifier passed without the action it modifies. Silently
// ignoring --reply-to would post a root comment the user believes is a reply.
func exactlyOneAction(cmd *cobra.Command) error {
	fl := cmd.Flags()
	if !fl.Changed("add") {
		for _, modifier := range []string{"reply-to", "quote"} {
			if fl.Changed(modifier) {
				return fmt.Errorf("--%s only applies with --add", modifier)
			}
		}
	}
	return nil
}

func listComments(
	cmd *cobra.Command,
	c *client.Client,
	o output.Options,
	doc item,
	showAll bool,
) error {
	comments, err := documentComments(cmd.Context(), c, doc.ID)
	if err != nil {
		return err
	}

	// resolved_at lives on the root, so a reply's state is its thread's.
	resolved := map[string]bool{}
	for _, cm := range comments {
		if cm.ParentComment == "" && cm.ResolvedAt != "" {
			resolved[cm.ID] = true
		}
	}

	var (
		rows    [][]string
		visible []comment
		hidden  int
	)
	for _, cm := range comments {
		// An archived comment is one whose anchor text was deleted from the
		// document. It is history, not an open question.
		if cm.ArchivedAt != "" && !showAll {
			hidden++
			continue
		}
		if resolved[threadOf(cm)] && !showAll {
			hidden++
			continue
		}
		visible = append(visible, cm)
		rows = append(rows, []string{
			threadCell(cm), cm.AuthorName, oneLine(cm.Body),
			quotedCell(cm), stateCell(cm, resolved), cm.ID,
		})
	}

	if err := o.Write(cmd.OutOrStdout(),
		[]string{"", "AUTHOR", "COMMENT", "ON", "STATE", "ID"}, rows, visible); err != nil {
		return err
	}
	if hidden > 0 {
		o.Info(cmd.ErrOrStderr(),
			"%d comment(s) hidden (resolved or archived) — pass --all to see them", hidden)
	}
	return nil
}

// threadCell indents a reply so a thread reads as a thread in a flat table.
func threadCell(cm comment) string {
	if cm.ParentComment != "" {
		return "  ↳"
	}
	return ""
}

func stateCell(cm comment, resolved map[string]bool) string {
	switch {
	case cm.ArchivedAt != "":
		return "archived"
	case resolved[threadOf(cm)]:
		return "resolved"
	default:
		return "open"
	}
}

// quotedCell shows what part of the document a comment is attached to, which
// is what makes a bare comment body intelligible out of context.
func quotedCell(cm comment) string {
	if cm.QuotedText == "" {
		return "-"
	}
	return truncate(oneLine(cm.QuotedText), 40)
}

func addComment(
	cmd *cobra.Command,
	c *client.Client,
	o output.Options,
	doc item,
	body, replyTo, quoted string,
) error {
	ctx := cmd.Context()

	userID, err := c.UserID(ctx)
	if err != nil {
		return err
	}
	// author_name is snapshotted at write time so a removed user still renders
	// with a name — the app does the same, and a comment written by the CLI
	// must not read differently.
	name, err := authorName(ctx, c, userID)
	if err != nil {
		return err
	}

	payload := map[string]any{
		"drive_item":  doc.ID,
		"body":        body,
		"author":      userID,
		"author_name": name,
		"quoted_text": quoted,
	}
	// comment_id is the EDITOR ANCHOR — the Tiptap mark's id, not the row id —
	// and the schema requires it. A comment written from the shell has no mark
	// to point at, so it gets a fresh anchor that simply matches nothing in the
	// document; that is what the app already does for a thread with no
	// selection (see text/lib/suggestions/discussions.ts). Omitting it fails
	// the create outright, which is what `--add` did on every invocation.
	payload["comment_id"] = newAnchorID()

	if replyTo != "" {
		// Replies are one level deep: replying to a reply attaches to its
		// thread root, matching how the app nests them.
		parent, err := client.GetRecord[comment](ctx, c, commentsCollection, replyTo)
		if err != nil {
			return fmt.Errorf("%s: %w", replyTo, err)
		}
		if parent.DriveItem != doc.ID {
			return fmt.Errorf("%s is a comment on a different document", replyTo)
		}
		payload["parent_comment"] = threadOf(parent)
		// A reply shares its thread's anchor so the drawer groups the two
		// together and a click on the marked text surfaces the whole thread.
		if parent.CommentID != "" {
			payload["comment_id"] = parent.CommentID
		}
	}

	created, err := client.CreateRecord[comment](ctx, c, commentsCollection, payload)
	if err != nil {
		return err
	}
	o.Info(cmd.ErrOrStderr(), "added comment %s on %s", created.ID, doc.Name)
	return o.Write(cmd.OutOrStdout(),
		[]string{"AUTHOR", "COMMENT", "ID"},
		[][]string{{created.AuthorName, oneLine(created.Body), created.ID}},
		created)
}

// setResolved marks a thread resolved or reopens it.
//
// Always applied to the thread ROOT: resolved_at lives there and replies
// inherit it, so stamping a reply would leave the thread open while looking
// resolved in the row the user acted on.
func setResolved(
	cmd *cobra.Command,
	c *client.Client,
	o output.Options,
	doc item,
	commentID string,
	resolved bool,
) error {
	ctx := cmd.Context()

	target, err := client.GetRecord[comment](ctx, c, commentsCollection, commentID)
	if err != nil {
		return fmt.Errorf("%s: %w", commentID, err)
	}
	if target.DriveItem != doc.ID {
		return fmt.Errorf("%s is a comment on a different document", commentID)
	}

	stamp := ""
	if resolved {
		stamp = time.Now().UTC().Format(time.RFC3339)
	}
	rootID := threadOf(target)
	if _, err := client.UpdateRecord[comment](ctx, c, commentsCollection, rootID,
		map[string]any{"resolved_at": stamp}); err != nil {
		return err
	}

	verb := "reopened"
	if resolved {
		verb = "resolved"
	}
	o.Info(cmd.ErrOrStderr(), "%s thread %s on %s", verb, rootID, doc.Name)
	return nil
}

// authorName reads the caller's display name for the snapshot field.
func authorName(ctx context.Context, c *client.Client, userID string) (string, error) {
	type userRow struct {
		Name  string `json:"name"`
		Email string `json:"email"`
	}
	u, err := client.GetRecord[userRow](ctx, c, "users", userID)
	if err != nil {
		return "", err
	}
	if u.Name != "" {
		return u.Name, nil
	}
	// An account with no display name still has an address, and a blank
	// author column reads as a bug.
	return u.Email, nil
}

// oneLine flattens a multi-line body for a table cell. The full text is in
// --json, which is where a caller goes for the whole thing.
func oneLine(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max-1] + "…"
}
