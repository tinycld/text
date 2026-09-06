package text

import "tinycld.org/core/oauth"

const (
	scopeRead  = "text:read"
	scopeWrite = "text:write"
)

// oauthPackage declares what an OAuth token may reach in text: ONLY the
// comment collection. The documents themselves are drive_items, governed by
// drive's scopes, so these are narrower than they look — a token that does
// anything useful with them holds drive:read too, and the comment rules reach
// through `drive_item` to the document's own access before any of this
// applies. Registered from registerShared.
func oauthPackage() oauth.Package {
	return oauth.Package{
		Slug: "text",
		Scopes: []oauth.Scope{
			{ID: scopeRead, Label: "Read comments on your documents"},
			{ID: scopeWrite, Label: "Add and resolve comments on your documents"},
		},
		Collections: map[string]oauth.Access{
			"text_comments": {Read: []string{scopeRead}, Write: []string{scopeWrite}},
		},
	}
}
