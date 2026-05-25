package text

import (
	"net/http"

	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/sharelink"
	"tinycld.org/packages/text/translate"
)

// registerShareRenderAPI binds the PUBLIC (unauthenticated) text render
// endpoint used by Drive's read-only share links. Access is gated by a
// signed share-session token (minted by drive), not by re.Auth — so an
// anonymous link visitor can render a shared document without a
// PocketBase account.
//
// Route: GET /api/text/share-render/{token}
//
// The {token} is the share-session JWT (not the link's public token).
// Images are forced to embed mode: the public iframe has no auth token to
// fetch image files, so the renderer inlines them as data: URIs.
func registerShareRenderAPI(app core.App) {
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.GET("/api/text/share-render/{token}", func(re *core.RequestEvent) error {
			return handleShareRender(app, re)
		})
		return e.Next()
	})
}

func handleShareRender(app core.App, re *core.RequestEvent) error {
	sessionToken := re.Request.PathValue("token")
	_, _, item, err := sharelink.VerifyAndResolve(app, sessionToken)
	if err != nil {
		return re.JSON(sharelink.HTTPStatus(err), map[string]string{"error": err.Error()})
	}

	if item.GetString("mime_type") != docxMimeType {
		return re.BadRequestError("not a docx", nil)
	}

	etag := renderETag(item.Id, item.GetString("updated"))
	if match := re.Request.Header.Get("If-None-Match"); match == etag {
		re.Response.Header().Set("ETag", etag)
		re.Response.Header().Set("Cache-Control", "private, max-age=0, must-revalidate")
		re.Response.WriteHeader(http.StatusNotModified)
		return nil
	}

	// Force embed: the anonymous iframe can't carry an auth token to
	// fetch image files, so the renderer inlines bytes as data URIs.
	clean, err := RenderItemHTML(app, item, translate.ImageModeEmbed)
	if err != nil {
		return re.InternalServerError("could not render document", err)
	}

	re.Response.Header().Set("Content-Type", "text/html; charset=utf-8")
	re.Response.Header().Set("ETag", etag)
	re.Response.Header().Set("Cache-Control", "private, max-age=0, must-revalidate")
	_, _ = re.Response.Write([]byte(clean))
	return nil
}
