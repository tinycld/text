import { z } from '@tinycld/core/ui/form'

// Shown when the user commits a blank rename. Centralised so tests + UI agree.
export const EMPTY_NAME_ERROR = 'Name cannot be empty'

// Generic mutation-failure copy. Sentry receives the real error via
// captureException; users see a short inline string instead of the
// raw message (which can be a stack-y server response).
export const RENAME_FAILED_ERROR = "Couldn't rename — try again"

// Mirrors the server's drive_items.name limit, so a name the server would
// reject never leaves the editor.
export const DOCUMENT_NAME_MAX_LENGTH = 500

// Whitespace-only input fails the same as empty, so a document can never
// end up with a "        " name nobody can recognise in a list.
export const documentNameSchema = z.object({
    name: z.string().trim().min(1, EMPTY_NAME_ERROR).max(DOCUMENT_NAME_MAX_LENGTH),
})

// An unchanged name is a cancel, not a write: submitting would
// optimistically write the same value.
export function isUnchangedName(validName: string, currentName: string) {
    return validName === currentName.trim()
}
