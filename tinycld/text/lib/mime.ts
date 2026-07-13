// DOCX_MIME_TYPE is the MIME type the opener actions filter on. Text
// documents in the system are drive_items with this exact mime; the
// preview action and drive item action both use this constant for the
// `isApplicable` check.
export const DOCX_MIME_TYPE =
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

// RTF MIME types the text editor also opens. Browsers report either of
// these for .rtf; both map to doctaculous FormatRTF server-side, and the
// bootstrap/flush paths bridge RTF ↔ docx around the ProseMirror model.
export const RTF_MIME_TYPE = 'application/rtf'
export const RTF_MIME_TYPE_ALT = 'text/rtf'

// TEXT_EDITOR_MIME_TYPES is the full set the opener actions and preview
// registration match on.
export const TEXT_EDITOR_MIME_TYPES = [DOCX_MIME_TYPE, RTF_MIME_TYPE, RTF_MIME_TYPE_ALT]

// isTextEditableMime reports whether the text editor can open a file of this
// mime — used by the opener actions' isApplicable predicates.
export function isTextEditableMime(mimeType: string): boolean {
    return (TEXT_EDITOR_MIME_TYPES as string[]).includes(mimeType)
}
