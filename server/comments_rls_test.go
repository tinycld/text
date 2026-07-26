package text

import (
	"net/http"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
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

// The rules below are copied verbatim from the migration that ships
// them, so a migration edit that isn't mirrored here surfaces as a
// failing assertion rather than a test that quietly validates a string
// only this file believes in.

// textCommentsViewRule mirrors the list/view rule in
// 1720000000_create_text_comments.js.
const textCommentsViewRule = `@request.auth.id != "" && drive_item.drive_shares_via_item.user ?= @request.auth.id`

// textCommentsUpdateRule mirrors the update/delete rule in the same
// migration: mutating someone else's comment is forbidden.
const textCommentsUpdateRule = `@request.auth.id != "" && author = @request.auth.id`

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

	items := core.NewBaseCollection("drive_items")
	items.Id = "pbc_drive_items_01"
	items.Fields.Add(&core.TextField{Name: "name", Required: true})
	items.Fields.Add(&core.RelationField{
		Name: "created_by", CollectionId: users.Id, MaxSelect: 1,
	})
	if err := app.Save(items); err != nil {
		t.Fatal(err)
	}

	shares := core.NewBaseCollection("drive_shares")
	shares.Id = "pbc_drive_shares_01"
	shares.Fields.Add(&core.RelationField{
		Name: "item", Required: true, CollectionId: items.Id,
		CascadeDelete: true, MaxSelect: 1,
	})
	shares.Fields.Add(&core.RelationField{
		Name: "user", Required: true, CollectionId: users.Id,
		CascadeDelete: true, MaxSelect: 1,
	})
	shares.Fields.Add(&core.SelectField{
		Name: "role", Required: true, MaxSelect: 1,
		Values: []string{"owner", "editor", "commentor", "viewer"},
	})
	if err := app.Save(shares); err != nil {
		t.Fatal(err)
	}

	comments := core.NewBaseCollection("text_comments")
	comments.Id = "pbc_text_comments_01"
	comments.Fields.Add(&core.RelationField{
		Name: "drive_item", Required: true, CollectionId: items.Id,
		CascadeDelete: true, MaxSelect: 1,
	})
	comments.Fields.Add(&core.TextField{Name: "comment_id", Required: true})
	comments.Fields.Add(&core.TextField{Name: "body"})
	comments.Fields.Add(&core.RelationField{
		Name: "author", Required: true, CollectionId: users.Id, MaxSelect: 1,
	})
	viewRule := textCommentsViewRule
	mutateRule := textCommentsUpdateRule
	comments.ListRule = &viewRule
	comments.ViewRule = &viewRule
	comments.UpdateRule = &mutateRule
	comments.DeleteRule = &mutateRule
	if err := app.Save(comments); err != nil {
		t.Fatal(err)
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
	if err := app.Save(share); err != nil {
		t.Fatal(err)
	}

	comment := core.NewRecord(comments)
	comment.Set("drive_item", item.Id)
	comment.Set("comment_id", "c1")
	comment.Set("body", "SECRET-COMMENT-BODY")
	comment.Set("author", sharee.Id)
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

// TestTextCommentsRLS_RuleMatchesMigration is the tripwire for the exact
// failure that motivated this file: a rule string that references a
// field the schema doesn't have. PB validates rules on save, so a stale
// `user_org` walk is rejected here rather than silently matching zero
// rows.
func TestTextCommentsRLS_RuleMatchesMigration(t *testing.T) {
	env := setupTextCommentsRLSApp(t)

	col, err := env.app.FindCollectionByNameOrId("text_comments")
	if err != nil {
		t.Fatal(err)
	}
	if got := col.ListRule; got == nil || *got != textCommentsViewRule {
		t.Errorf("listRule = %v, want %q", got, textCommentsViewRule)
	}

	// The pre-migration rule must be rejected outright — proof that the
	// field rename is load-bearing and not cosmetic.
	stale := `@request.auth.id != "" && drive_item.drive_shares_via_item.user_org ?= @request.auth.id`
	col.ListRule = &stale
	if err := env.app.Save(col); err == nil {
		t.Error("stale user_org rule saved without error; the rule engine should reject the unknown field")
	}
}
