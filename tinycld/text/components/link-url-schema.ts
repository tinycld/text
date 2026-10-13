import { z } from '@tinycld/core/ui/form'

export const INVALID_LINK_ERROR = 'Enter a valid link, like https://example.com'

// The editor stores the href exactly as given and its link mark accepts
// any scheme-less string as a relative URL, so a bare "example.com"
// would be saved as a link to a path on this site. Give scheme-less
// input an https:// prefix instead.
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i

// Web links need a host with at least one dot (or localhost); the
// schemes are the ones the editor's link mark allows by default.
const WEB_LINK =
    /^(?:https?|ftps?):\/\/(?:[^\s/?#@]+@)?(?:localhost|[^\s/?#:@.]+(?:\.[^\s/?#:@.]+)+)(?::\d+)?(?:[/?#]\S*)?$/i
const OTHER_LINK = /^(?:mailto|tel|callto|sms|cid|xmpp):\S+$/i
// In-document anchors, such as the bookmarks a .docx table of contents
// links to.
const ANCHOR_LINK = /^#\S+$/

export function normalizeLinkUrl(raw: string) {
    if (raw === '' || raw.startsWith('#') || HAS_SCHEME.test(raw)) return raw
    return `https://${raw}`
}

function isValidLinkUrl(url: string) {
    return url === '' || WEB_LINK.test(url) || OTHER_LINK.test(url) || ANCHOR_LINK.test(url)
}

// An empty URL is valid: it tells the caller to remove the link.
export const linkUrlSchema = z.object({
    url: z.string().trim().transform(normalizeLinkUrl).refine(isValidLinkUrl, INVALID_LINK_ERROR),
})
