package cli

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

// docs builds the standard fixture:
//
//	/Plan.md          (itmPlan)  — one open thread with a reply, one resolved
//	/Notes/Draft.md   (itmDraft) — one comment, to prove scoping
//	/Notes            (itmNotes) — a folder
func docs(t *testing.T) *fakeText {
	f := newFakeText(t)
	f.addItem("itmPlan", "Plan.md", "", false)
	f.addItem("itmNotes", "Notes", "", true)
	f.addItem("itmDraft", "Draft.md", "itmNotes", false)

	open := f.addComment("cmtOpen", "itmPlan", "Needs a rewrite", "Ada")
	open.QuotedText = "the second paragraph"
	// The editor anchor. The fixture left this empty for a long time, which is
	// part of why the missing comment_id on create went unnoticed — a fake
	// server that never sets a field cannot notice a client that never sends
	// one.
	open.CommentID = "anchorOpen"
	reply := f.addComment("cmtReply", "itmPlan", "Agreed", "Grace")
	reply.ParentComment = "cmtOpen"
	reply.CommentID = "anchorOpen"

	done := f.addComment("cmtDone", "itmPlan", "Fixed the typo", "Ada")
	done.ResolvedAt = "2026-08-01 12:00:00Z"

	f.addComment("cmtOther", "itmDraft", "On another document", "Ada")
	return f
}

func TestCommentsListsOpenThreads(t *testing.T) {
	f := docs(t)
	_, c := f.serve()

	out, _, err := runCmd(t, c, "text", "comments", "/Plan.md")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Needs a rewrite", "Agreed", "Ada", "Grace"} {
		if !strings.Contains(out, want) {
			t.Errorf("comments missing %q:\n%s", want, out)
		}
	}
	// The quoted text is what makes a bare comment intelligible out of context.
	if !strings.Contains(out, "the second paragraph") {
		t.Errorf("comments must show what text a comment is anchored to:\n%s", out)
	}
}

// A resolved thread is answered. Showing it by default buries the open ones.
func TestCommentsHidesResolvedUnlessAll(t *testing.T) {
	f := docs(t)
	_, c := f.serve()

	out, errOut, err := runCmd(t, c, "text", "comments", "/Plan.md")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "Fixed the typo") {
		t.Errorf("a resolved thread was listed by default:\n%s", out)
	}
	if !strings.Contains(errOut, "hidden") {
		t.Errorf("hiding comments must be reported, not silent: %s", errOut)
	}

	out, _, err = runCmd(t, c, "text", "comments", "/Plan.md", "--all")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "Fixed the typo") {
		t.Errorf("--all must include resolved threads:\n%s", out)
	}
}

// A REPLY inherits its thread's resolved state — resolved_at lives on the root
// only. A reply to a resolved thread showing as open would be a phantom task.
func TestCommentsHidesRepliesOfResolvedThreads(t *testing.T) {
	f := docs(t)
	f.comments["cmtOpen"].ResolvedAt = "2026-08-02 09:00:00Z"
	_, c := f.serve()

	out, _, err := runCmd(t, c, "text", "comments", "/Plan.md")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "Agreed") {
		t.Errorf("a reply on a resolved thread must be hidden too:\n%s", out)
	}
}

// An archived comment is one whose anchor text was deleted from the document.
// It is history, not an open question.
func TestCommentsHidesArchivedUnlessAll(t *testing.T) {
	f := docs(t)
	f.comments["cmtOpen"].ArchivedAt = "2026-08-02 09:00:00Z"
	_, c := f.serve()

	out, _, err := runCmd(t, c, "text", "comments", "/Plan.md")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "Needs a rewrite") {
		t.Errorf("an archived comment was listed by default:\n%s", out)
	}
	out, _, err = runCmd(t, c, "text", "comments", "/Plan.md", "--all")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "archived") {
		t.Errorf("--all must show archived comments and mark them:\n%s", out)
	}
}

// The whole point of the drive_item filter. A command that read every comment
// would leak other documents' discussions into this one's thread.
func TestCommentsScopedToOneDocument(t *testing.T) {
	f := docs(t)
	_, c := f.serve()

	out, _, err := runCmd(t, c, "text", "comments", "/Plan.md")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "On another document") {
		t.Errorf("comments leaked from another document:\n%s", out)
	}
}

// A nested path must resolve one segment at a time, the way drive does.
func TestResolvesNestedPath(t *testing.T) {
	f := docs(t)
	_, c := f.serve()

	out, _, err := runCmd(t, c, "text", "comments", "/Notes/Draft.md")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "On another document") {
		t.Errorf("nested path did not resolve to the right document:\n%s", out)
	}
}

// `id:<record id>` is the same escape hatch `tinycld drive` accepts.
func TestResolvesByIDPrefix(t *testing.T) {
	f := docs(t)
	_, c := f.serve()

	out, _, err := runCmd(t, c, "text", "comments", "id:itmPlan")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "Needs a rewrite") {
		t.Errorf("id: reference did not resolve:\n%s", out)
	}
}

// A folder has no comments; answering with an empty list would read as "no
// discussion here" rather than "you named the wrong thing".
func TestFolderIsRejected(t *testing.T) {
	f := docs(t)
	_, c := f.serve()

	_, _, err := runCmd(t, c, "text", "comments", "/Notes")
	if err == nil {
		t.Fatal("a folder must be rejected, not answered with an empty list")
	}
	if !strings.Contains(err.Error(), "folder") {
		t.Errorf("the error should say it is a folder, got: %v", err)
	}
}

func TestUnknownPathFails(t *testing.T) {
	f := docs(t)
	_, c := f.serve()
	if _, _, err := runCmd(t, c, "text", "comments", "/Nope.md"); err == nil {
		t.Fatal("an unknown path must fail")
	}
}

func TestAddPostsComment(t *testing.T) {
	f := docs(t)
	_, c := f.serve()

	if _, _, err := runCmd(t, c, "text", "comments", "/Plan.md",
		"--add", "One more thing", "--quote", "the heading"); err != nil {
		t.Fatal(err)
	}

	for key, want := range map[string]any{
		"drive_item":  "itmPlan",
		"body":        "One more thing",
		"author":      "user1",
		"quoted_text": "the heading",
		// Snapshotted at write time so a removed user still renders with a
		// name — the app does the same.
		"author_name": "Ada Lovelace",
	} {
		if got := f.lastCreate[key]; got != want {
			t.Errorf("create[%q] = %v, want %v", key, got, want)
		}
	}
	if got, ok := f.lastCreate["parent_comment"]; ok && got != "" {
		t.Errorf("a root comment must not carry a parent, got %v", got)
	}
	// comment_id is REQUIRED by the schema. The fake server validates nothing,
	// so its absence here passed every test while every real `--add` failed
	// with "Failed to create record" — found by the live smoke test, which is
	// why this assertion is explicit rather than folded into the table above.
	anchor, _ := f.lastCreate["comment_id"].(string)
	if anchor == "" {
		t.Error("create carried no comment_id; the real server rejects that as a required field")
	}
}

// Two comments must not share an anchor: the drawer groups by comment_id, so a
// repeated value would silently merge unrelated threads.
func TestAddGeneratesADistinctAnchorPerComment(t *testing.T) {
	f := docs(t)
	_, c := f.serve()

	if _, _, err := runCmd(t, c, "text", "comments", "/Plan.md", "--add", "First"); err != nil {
		t.Fatal(err)
	}
	first, _ := f.lastCreate["comment_id"].(string)

	if _, _, err := runCmd(t, c, "text", "comments", "/Plan.md", "--add", "Second"); err != nil {
		t.Fatal(err)
	}
	second, _ := f.lastCreate["comment_id"].(string)

	if first == "" || second == "" {
		t.Fatalf("expected an anchor on both comments, got %q and %q", first, second)
	}
	if first == second {
		t.Errorf("both comments share anchor %q — unrelated threads would merge", first)
	}
}

// A reply belongs to its thread's anchor, so clicking the marked text in the
// editor surfaces the whole conversation rather than only the root.
func TestReplyInheritsTheThreadAnchor(t *testing.T) {
	f := docs(t)
	_, c := f.serve()

	if _, _, err := runCmd(t, c, "text", "comments", "/Plan.md",
		"--reply-to", "cmtOpen", "--add", "Will do"); err != nil {
		t.Fatal(err)
	}
	if got := f.lastCreate["comment_id"]; got != "anchorOpen" {
		t.Errorf("comment_id = %v, want the thread's anchor anchorOpen", got)
	}
}

func TestReplyAttachesToThread(t *testing.T) {
	f := docs(t)
	_, c := f.serve()

	if _, _, err := runCmd(t, c, "text", "comments", "/Plan.md",
		"--reply-to", "cmtOpen", "--add", "Will do"); err != nil {
		t.Fatal(err)
	}
	if got := f.lastCreate["parent_comment"]; got != "cmtOpen" {
		t.Errorf("parent_comment = %v, want cmtOpen", got)
	}
}

// Replies are one level deep: replying to a reply attaches to its thread root,
// matching how the app nests them. Otherwise the tree grows a level the
// renderer cannot show.
func TestReplyToAReplyAttachesToTheRoot(t *testing.T) {
	f := docs(t)
	_, c := f.serve()

	if _, _, err := runCmd(t, c, "text", "comments", "/Plan.md",
		"--reply-to", "cmtReply", "--add", "Me too"); err != nil {
		t.Fatal(err)
	}
	if got := f.lastCreate["parent_comment"]; got != "cmtOpen" {
		t.Errorf("parent_comment = %v, want the thread root cmtOpen", got)
	}
}

// A comment id from another document must not be usable here — it would
// silently attach this document's reply to that document's thread.
func TestReplyToAnotherDocumentsCommentFails(t *testing.T) {
	f := docs(t)
	_, c := f.serve()

	_, _, err := runCmd(t, c, "text", "comments", "/Plan.md",
		"--reply-to", "cmtOther", "--add", "Wrong doc")
	if err == nil {
		t.Fatal("replying with another document's comment id must fail")
	}
	if f.lastCreate != nil {
		t.Errorf("a refused reply still posted: %v", f.lastCreate)
	}
}

// Silently ignoring --reply-to would post a root comment the user believes is
// a reply.
func TestModifierWithoutAddFails(t *testing.T) {
	f := docs(t)
	_, c := f.serve()

	for _, args := range [][]string{
		{"text", "comments", "/Plan.md", "--reply-to", "cmtOpen"},
		{"text", "comments", "/Plan.md", "--quote", "something"},
	} {
		if _, _, err := runCmd(t, c, args...); err == nil {
			t.Errorf("expected a failure for %v", args)
		}
	}
}

func TestResolveStampsTheThread(t *testing.T) {
	f := docs(t)
	_, c := f.serve()

	if _, _, err := runCmd(t, c, "text", "comments", "/Plan.md", "--resolve", "cmtOpen"); err != nil {
		t.Fatal(err)
	}
	if f.patchedID != "cmtOpen" {
		t.Errorf("patched %q, want cmtOpen", f.patchedID)
	}
	stamp, _ := f.lastPatch["resolved_at"].(string)
	if stamp == "" {
		t.Fatalf("resolve must set a non-empty resolved_at, got %v", f.lastPatch)
	}
}

// resolved_at lives on the ROOT and replies inherit it, so resolving a reply
// must stamp its thread root — otherwise the thread stays open while the row
// the user acted on looks resolved.
func TestResolvingAReplyStampsTheRoot(t *testing.T) {
	f := docs(t)
	_, c := f.serve()

	if _, _, err := runCmd(t, c, "text", "comments", "/Plan.md", "--resolve", "cmtReply"); err != nil {
		t.Fatal(err)
	}
	if f.patchedID != "cmtOpen" {
		t.Errorf("patched %q, want the thread root cmtOpen", f.patchedID)
	}
}

func TestReopenClearsTheStamp(t *testing.T) {
	f := docs(t)
	_, c := f.serve()

	if _, _, err := runCmd(t, c, "text", "comments", "/Plan.md", "--reopen", "cmtDone"); err != nil {
		t.Fatal(err)
	}
	if f.patchedID != "cmtDone" {
		t.Errorf("patched %q, want cmtDone", f.patchedID)
	}
	if got, ok := f.lastPatch["resolved_at"].(string); !ok || got != "" {
		t.Errorf("reopen must clear resolved_at, got %v", f.lastPatch)
	}
}

func TestResolveAnotherDocumentsCommentFails(t *testing.T) {
	f := docs(t)
	_, c := f.serve()

	if _, _, err := runCmd(t, c, "text", "comments", "/Plan.md", "--resolve", "cmtOther"); err == nil {
		t.Fatal("resolving another document's comment must fail")
	}
}

func TestActionsAreMutuallyExclusive(t *testing.T) {
	f := docs(t)
	_, c := f.serve()

	if _, _, err := runCmd(t, c, "text", "comments", "/Plan.md",
		"--add", "x", "--resolve", "cmtOpen"); err == nil {
		t.Fatal("--add and --resolve together must fail")
	}
}

func TestJSONOutputIsStable(t *testing.T) {
	f := docs(t)
	_, c := f.serve()

	out, _, err := runCmd(t, c, "text", "comments", "/Plan.md", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var comments []comment
	if err := json.Unmarshal([]byte(out), &comments); err != nil {
		t.Fatalf("--json output is not a stable JSON array: %v\n%s", err, out)
	}
	if len(comments) != 2 {
		t.Errorf("--json returned %d comments, want 2 (the open thread)", len(comments))
	}
	// The full body survives into --json even though the table one-lines it.
	if comments[0].Body != "Needs a rewrite" {
		t.Errorf("--json must carry the full body, got %q", comments[0].Body)
	}
}

// truncate slices runes, not bytes: quoted text is arbitrary user prose, and a
// byte cut through a multi-byte character emits invalid UTF-8.
func TestTruncateDoesNotSplitRunes(t *testing.T) {
	// 60 CJK characters — 3 bytes each, so a byte-based cut lands mid-rune.
	long := strings.Repeat("東", 60)
	got := truncate(long, 40)

	if !utf8.ValidString(got) {
		t.Fatalf("truncate emitted invalid UTF-8: %q", got)
	}
	if strings.ContainsRune(got, utf8.RuneError) {
		t.Fatalf("truncate cut a rune in half: %q", got)
	}
	if n := utf8.RuneCountInString(got); n != 40 {
		t.Errorf("truncate produced %d runes, want 40", n)
	}
	if !strings.HasSuffix(got, "…") {
		t.Errorf("truncated text must be marked with an ellipsis: %q", got)
	}

	// Short input is returned untouched, including multi-byte text whose BYTE
	// length exceeds the limit while its rune count does not.
	for _, s := range []string{"", "short", strings.Repeat("é", 40)} {
		if got := truncate(s, 40); got != s {
			t.Errorf("truncate(%q) = %q, want it unchanged", s, got)
		}
	}
}
