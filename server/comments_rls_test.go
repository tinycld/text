package text

import (
	"net/http"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"tinycld.org/core/rlstest"
)

// comments_rls_test.go proves text_comments' access rules against
// PocketBase's REAL rule engine: a user may read a comment only when
// they hold a drive_shares row on the commented-on drive_item, and may
// only mutate their own comments.
//
// This file exists because these rules had rotted undetected. They
// walked `drive_shares_via_item.user_org`, a field drive renamed to
// `user` during the single-org migration, which made every list/view
// return zero rows and every create 403 — with no compile error and no
// failing test, because nothing asserted them. PB rejects the stale rule
// outright at migration-apply time now, but only for a fresh DB; a guard
// here is what catches the next silent divergence.
//
// Each scenario builds a FRESH TestApp: ApiScenario.Test re-triggers
// OnServe, and reusing one app panics on duplicate route registration.

// The rules are NOT restated here. text_comments and its rules come from
// text's own pb-migrations, applied against the test app, so what is asserted
// below is what ships. The earlier version of this file kept the rules as
// constants "copied verbatim from the migration" — the same arrangement that,
// over in drive, let a shipped rule quietly lose a security clause while the
// suite guarding it stayed green against its own stale copy.
//
// drive_items and drive_shares are still built by hand: they belong to a
// different package whose migrations this module does not carry. Only the
// collection whose rules are under test comes from a real migration.

type textCommentsEnv struct {
	app         *tests.TestApp
	sharee      *core.Record
	stranger    *core.Record
	item        *core.Record
	comment     *core.Record
	shareeToken string
	strangerTok string
}

// setupTextCommentsRLSApp builds the real collection graph the rules
// walk: users → drive_shares → drive_items ← text_comments. drive_shares
// must exist for the `drive_shares_via_item` back-relation to parse at
// all.
func setupTextCommentsRLSApp(t *testing.T) *textCommentsEnv {
	t.Helper()
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("NewTestApp: %v", err)
	}
	t.Cleanup(func() { app.Cleanup() })

	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}

	// `disabled` belongs to core's users schema, which this module does not
	// carry; the rules under test read it, so it has to exist before they are
	// installed.
	users.Fields.Add(&core.BoolField{Name: "disabled"})
	if err := app.Save(users); err != nil {
		t.Fatalf("add users.disabled: %v", err)
	}

	// The whole collection graph — drive's items/shares/versions and text's
	// comments, schema and access rules alike — comes from the two packages'
	// real migrations. drive's run first: text's version migrations alter
	// drive_item_versions, and the comment rules walk drive_shares.
	rlstest.Apply(t, app,
		rlstest.MigrationsDir(t, "../../drive/pb-migrations"),
		rlstest.MigrationsDir(t, "../pb-migrations"),
	)

	items, err := app.FindCollectionByNameOrId("drive_items")
	if err != nil {
		t.Fatal(err)
	}
	shares, err := app.FindCollectionByNameOrId("drive_shares")
	if err != nil {
		t.Fatal(err)
	}
	comments, err := app.FindCollectionByNameOrId("text_comments")
	if err != nil {
		t.Fatalf("text_comments should have been created by the migrations: %v", err)
	}

	sharee := textCommentsUser(t, app, "sharee@test.local")
	stranger := textCommentsUser(t, app, "stranger@test.local")

	item := core.NewRecord(items)
	item.Set("name", "doc.docx")
	item.Set("created_by", sharee.Id)
	if err := app.Save(item); err != nil {
		t.Fatal(err)
	}

	share := core.NewRecord(shares)
	share.Set("item", item.Id)
	share.Set("user", sharee.Id)
	share.Set("role", "editor")
	share.Set("created_by", sharee.Id)
	if err := app.Save(share); err != nil {
		t.Fatal(err)
	}

	comment := core.NewRecord(comments)
	comment.Set("drive_item", item.Id)
	comment.Set("comment_id", "c1")
	comment.Set("body", "SECRET-COMMENT-BODY")
	comment.Set("author", sharee.Id)
	comment.Set("author_name", "Sharee")
	if err := app.Save(comment); err != nil {
		t.Fatal(err)
	}

	shareeToken, err := sharee.NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}
	strangerTok, err := stranger.NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}

	return &textCommentsEnv{
		app: app, sharee: sharee, stranger: stranger,
		item: item, comment: comment,
		shareeToken: shareeToken, strangerTok: strangerTok,
	}
}

func textCommentsUser(t *testing.T, app core.App, email string) *core.Record {
	t.Helper()
	col, _ := app.FindCollectionByNameOrId("users")
	r := core.NewRecord(col)
	r.SetEmail(email)
	r.Set("name", "Test")
	r.SetVerified(true)
	r.SetPassword("Password123!")
	if err := app.Save(r); err != nil {
		t.Fatal(err)
	}
	return r
}

// TestTextCommentsRLS_ShareeCanList is the positive control. Without it,
// a rule that denies EVERYONE (the exact bug this file was written for)
// would still pass the deny-side tests below.
func TestTextCommentsRLS_ShareeCanList(t *testing.T) {
	env := setupTextCommentsRLSApp(t)

	scenario := &tests.ApiScenario{
		Name:                  "sharee lists text_comments",
		Method:                http.MethodGet,
		URL:                   "/api/collections/text_comments/records",
		Headers:               map[string]string{"Authorization": env.shareeToken},
		ExpectedStatus:        200,
		ExpectedContent:       []string{`"totalItems":1`, "SECRET-COMMENT-BODY"},
		TestAppFactory:        func(t testing.TB) *tests.TestApp { return env.app },
		DisableTestAppCleanup: true,
	}
	scenario.Test(t)
}

// TestTextCommentsRLS_StrangerCannotList is the confidentiality guard: a
// user with no drive_shares row on the item must not see its comments.
func TestTextCommentsRLS_StrangerCannotList(t *testing.T) {
	env := setupTextCommentsRLSApp(t)

	scenario := &tests.ApiScenario{
		Name:                  "stranger lists text_comments",
		Method:                http.MethodGet,
		URL:                   "/api/collections/text_comments/records",
		Headers:               map[string]string{"Authorization": env.strangerTok},
		ExpectedStatus:        200,
		ExpectedContent:       []string{`"totalItems":0`},
		NotExpectedContent:    []string{"SECRET-COMMENT-BODY"},
		TestAppFactory:        func(t testing.TB) *tests.TestApp { return env.app },
		DisableTestAppCleanup: true,
	}
	scenario.Test(t)
}

// TestTextCommentsRLS_StrangerCannotView pins the single-record path
// too: a direct fetch by id must 404, not merely be filtered out of the
// list.
func TestTextCommentsRLS_StrangerCannotView(t *testing.T) {
	env := setupTextCommentsRLSApp(t)

	scenario := &tests.ApiScenario{
		Name:                  "stranger views one text_comment",
		Method:                http.MethodGet,
		URL:                   "/api/collections/text_comments/records/" + env.comment.Id,
		Headers:               map[string]string{"Authorization": env.strangerTok},
		ExpectedStatus:        404,
		NotExpectedContent:    []string{"SECRET-COMMENT-BODY"},
		TestAppFactory:        func(t testing.TB) *tests.TestApp { return env.app },
		DisableTestAppCleanup: true,
	}
	scenario.Test(t)
}

// TestTextCommentsRLS_StrangerCannotDelete pins the mutate rule: even a
// user who could somehow name the record may not delete someone else's
// comment.
func TestTextCommentsRLS_StrangerCannotDelete(t *testing.T) {
	env := setupTextCommentsRLSApp(t)

	scenario := &tests.ApiScenario{
		Name:                  "stranger deletes another user's comment",
		Method:                http.MethodDelete,
		URL:                   "/api/collections/text_comments/records/" + env.comment.Id,
		Headers:               map[string]string{"Authorization": env.strangerTok},
		ExpectedStatus:        404,
		ExpectedContent:       []string{`"status":404`},
		TestAppFactory:        func(t testing.TB) *tests.TestApp { return env.app },
		DisableTestAppCleanup: true,
	}
	scenario.Test(t)
}

// TestTextCommentsRLS_AnonCannotList pins the `@request.auth.id != ""`
// conjunct: the route admits an unauthenticated list, but the rule
// matches nothing, so no comment body may leak.
func TestTextCommentsRLS_AnonCannotList(t *testing.T) {
	env := setupTextCommentsRLSApp(t)

	scenario := &tests.ApiScenario{
		Name:                  "anonymous lists text_comments",
		Method:                http.MethodGet,
		URL:                   "/api/collections/text_comments/records",
		ExpectedStatus:        200,
		ExpectedContent:       []string{`"totalItems":0`},
		NotExpectedContent:    []string{"SECRET-COMMENT-BODY"},
		TestAppFactory:        func(t testing.TB) *tests.TestApp { return env.app },
		DisableTestAppCleanup: true,
	}
	scenario.Test(t)
}

// commentsUser creates a user, optionally suspended, and returns it with an
// auth token minted before the suspension — the realistic case, since a
// suspended account's client is holding a token it obtained while active.
func commentsUser(t *testing.T, app core.App, email string, disabled bool) (*core.Record, string) {
	t.Helper()
	u := textCommentsUser(t, app, email)
	token, err := u.NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}
	if disabled {
		fresh, err := app.FindRecordById("users", u.Id)
		if err != nil {
			t.Fatal(err)
		}
		fresh.Set("disabled", true)
		if err := app.Save(fresh); err != nil {
			t.Fatal(err)
		}
	}
	return u, token
}

// shareWith grants the given user a role on the env's item.
func shareWith(t *testing.T, env *textCommentsEnv, user *core.Record, role string) {
	t.Helper()
	shares, err := env.app.FindCollectionByNameOrId("drive_shares")
	if err != nil {
		t.Fatal(err)
	}
	r := core.NewRecord(shares)
	r.Set("item", env.item.Id)
	r.Set("user", user.Id)
	r.Set("role", role)
	r.Set("created_by", env.sharee.Id)
	if err := env.app.Save(r); err != nil {
		t.Fatal(err)
	}
}

// A suspended user's share rows survive their suspension, and the Go gate
// never runs for /api/collections/*_comments — PocketBase evaluates these
// rules instead. So without the disabled clause a suspended account keeps
// full comment access over plain REST.
// One app per scenario, not per test: ApiScenario.Test re-triggers OnServe, so
// two scenarios sharing an app double-register routes. That is why each verb
// is its own top-level test rather than a subtest sharing one env.
func TestTextCommentsRLS_DisabledShareeCannotList(t *testing.T) {
	env := setupTextCommentsRLSApp(t)
	suspended, token := commentsUser(t, env.app, "suspended@test.local", true)
	shareWith(t, env, suspended, "editor")

	(&tests.ApiScenario{
		Method:                http.MethodGet,
		URL:                   "/api/collections/text_comments/records",
		Headers:               map[string]string{"Authorization": token},
		ExpectedStatus:        200,
		ExpectedContent:       []string{`"totalItems":0`},
		NotExpectedContent:    []string{"SECRET-COMMENT-BODY"},
		TestAppFactory:        func(t testing.TB) *tests.TestApp { return env.app },
		DisableTestAppCleanup: true,
	}).Test(t)
}

func TestTextCommentsRLS_DisabledShareeCannotView(t *testing.T) {
	env := setupTextCommentsRLSApp(t)
	suspended, token := commentsUser(t, env.app, "suspended@test.local", true)
	shareWith(t, env, suspended, "editor")

	(&tests.ApiScenario{
		Method:                http.MethodGet,
		URL:                   "/api/collections/text_comments/records/" + env.comment.Id,
		Headers:               map[string]string{"Authorization": token},
		ExpectedStatus:        404,
		ExpectedContent:       []string{`"message"`},
		NotExpectedContent:    []string{"SECRET-COMMENT-BODY"},
		TestAppFactory:        func(t testing.TB) *tests.TestApp { return env.app },
		DisableTestAppCleanup: true,
	}).Test(t)
}

func TestTextCommentsRLS_DisabledShareeCannotCreate(t *testing.T) {
	env := setupTextCommentsRLSApp(t)
	suspended, token := commentsUser(t, env.app, "suspended@test.local", true)
	shareWith(t, env, suspended, "editor")

	(&tests.ApiScenario{
		Method: http.MethodPost,
		URL:    "/api/collections/text_comments/records",
		Body: strings.NewReader(`{"drive_item":"` + env.item.Id +
			`","comment_id":"c-suspended","body":"x","author":"` + suspended.Id + `","author_name":"Tester"}`),
		Headers: map[string]string{
			"Authorization": token, "Content-Type": "application/json",
		},
		ExpectedStatus:        400,
		ExpectedContent:       []string{`"message"`},
		TestAppFactory:        func(t testing.TB) *tests.TestApp { return env.app },
		DisableTestAppCleanup: true,
	}).Test(t)
}

// The positive control for all three verbs above: an enabled sharee still has
// full comment access. Without it, a rule denying everyone would pass the
// deny-tests — the exact bug this file was originally written for.
func TestTextCommentsRLS_EnabledShareeCanComment(t *testing.T) {
	env := setupTextCommentsRLSApp(t)
	user, token := commentsUser(t, env.app, "enabled@test.local", false)
	shareWith(t, env, user, "editor")

	(&tests.ApiScenario{
		Method: http.MethodPost,
		URL:    "/api/collections/text_comments/records",
		Body: strings.NewReader(`{"drive_item":"` + env.item.Id +
			`","comment_id":"c-enabled","body":"hello","author":"` + user.Id + `","author_name":"Tester"}`),
		Headers: map[string]string{
			"Authorization": token, "Content-Type": "application/json",
		},
		ExpectedStatus:        200,
		ExpectedContent:       []string{`"comment_id":"c-enabled"`},
		TestAppFactory:        func(t testing.TB) *tests.TestApp { return env.app },
		DisableTestAppCleanup: true,
	}).Test(t)
}

// A commentor's entire purpose is commenting. Tightening these rules must not
// take that away — the two changes meet here, and locking the commentor out of
// commenting is the easy mistake.
func TestTextCommentsRLS_CommentorCanComment(t *testing.T) {
	env := setupTextCommentsRLSApp(t)
	user, token := commentsUser(t, env.app, "commentor@test.local", false)
	shareWith(t, env, user, "commentor")

	(&tests.ApiScenario{
		Method: http.MethodPost,
		URL:    "/api/collections/text_comments/records",
		Body: strings.NewReader(`{"drive_item":"` + env.item.Id +
			`","comment_id":"c-commentor","body":"a note","author":"` + user.Id + `","author_name":"Tester"}`),
		Headers: map[string]string{
			"Authorization": token, "Content-Type": "application/json",
		},
		ExpectedStatus:        200,
		ExpectedContent:       []string{`"comment_id":"c-commentor"`},
		TestAppFactory:        func(t testing.TB) *tests.TestApp { return env.app },
		DisableTestAppCleanup: true,
	}).Test(t)
}

// The document's creator may hold no drive_shares row at all — drive's
// owner-share hook can be bypassed by a direct SDK write, and historically
// was. Without the creator disjunct they can open and edit the document while
// seeing zero comments on it and being unable to post one.
func TestTextCommentsRLS_DocumentCreatorWithoutShareCanComment(t *testing.T) {
	env := setupTextCommentsRLSApp(t)
	creator, token := commentsUser(t, env.app, "creator@test.local", false)

	items, err := env.app.FindCollectionByNameOrId("drive_items")
	if err != nil {
		t.Fatal(err)
	}
	item := core.NewRecord(items)
	item.Set("name", "unshared.docx")
	item.Set("created_by", creator.Id)
	if err := env.app.Save(item); err != nil {
		t.Fatal(err)
	}

	(&tests.ApiScenario{
		Method: http.MethodPost,
		URL:    "/api/collections/text_comments/records",
		Body: strings.NewReader(`{"drive_item":"` + item.Id +
			`","comment_id":"c-creator","body":"mine","author":"` + creator.Id + `","author_name":"Tester"}`),
		Headers: map[string]string{
			"Authorization": token, "Content-Type": "application/json",
		},
		ExpectedStatus:        200,
		ExpectedContent:       []string{`"comment_id":"c-creator"`},
		TestAppFactory:        func(t testing.TB) *tests.TestApp { return env.app },
		DisableTestAppCleanup: true,
	}).Test(t)
}

// TestTextCommentsRLS_ShippedRulesCarryTheirGuards names the clauses each
// shipped rule is meant to contribute, so a migration that restates a rule and
// silently drops one says which one went missing — the failure mode that cost
// drive its guest-exclusion clause.
func TestTextCommentsRLS_ShippedRulesCarryTheirGuards(t *testing.T) {
	env := setupTextCommentsRLSApp(t)

	for _, kind := range []string{"list", "view", "create"} {
		rlstest.RequireRuleContains(t, env.app, "text_comments", kind,
			`@request.auth.disabled != true`)
		// drive_items reads `created_by ?= auth.id || <has-share>`; comments
		// must too, or the document's own creator sees none of them.
		rlstest.RequireRuleContains(t, env.app, "text_comments", kind,
			`drive_item.created_by ?= @request.auth.id`)
	}
	for _, kind := range []string{"update", "delete"} {
		rlstest.RequireRuleContains(t, env.app, "text_comments", kind,
			`@request.auth.disabled != true`)
		rlstest.RequireRuleContains(t, env.app, "text_comments", kind,
			`author = @request.auth.id`)
	}
}

// TestTextCommentsRLS_StaleFieldWalkIsRejected pins the failure that motivated
// this file: a rule string referencing a field the schema doesn't have. These
// rules once walked `drive_shares_via_item.user_org`, a field drive renamed to
// `user`, which made every list return zero rows and every create 403 with no
// compile error. PB validates rules on save, so the stale walk is refused here
// rather than silently matching nothing.
func TestTextCommentsRLS_StaleFieldWalkIsRejected(t *testing.T) {
	env := setupTextCommentsRLSApp(t)

	col, err := env.app.FindCollectionByNameOrId("text_comments")
	if err != nil {
		t.Fatal(err)
	}
	stale := `@request.auth.id != "" && drive_item.drive_shares_via_item.user_org ?= @request.auth.id`
	col.ListRule = &stale
	if err := env.app.Save(col); err == nil {
		t.Error("stale user_org rule saved without error; the rule engine should reject the unknown field")
	}
}
