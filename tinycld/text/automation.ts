import type { AutomationDefinitions } from '@tinycld/core/lib/automation/types'
import type { TextSchema } from './types'

// No ownerField here even though `author` is a relation to users, which the
// engine's auto-detection would find: scoping a personal rule to the comment's
// AUTHOR means it fires when you comment, which is backwards. The useful rule
// is "tell me when someone comments on a document of mine".
//
// server/automation.go registers a resolver over the document's participants
// (driveshare.ParticipantIDs) that supersedes auto-detection. Auto-detection
// remains the fallback for a deployment where text's Go isn't linked, where
// author-scoped is at least correct, just narrow.
//
// No actions. Nothing record-shaped in text closes a visible loop — content
// lives in Yjs, not in rows a rule could write.
const automation = {
    triggers: [
        {
            id: 'comment-added',
            label: 'A comment is added to a document',
            collection: 'text_comments',
            on: 'create',
            fields: [
                { key: 'body', label: 'Comment' },
                { key: 'quoted_text', label: 'Quoted text' },
                { key: 'author_name', label: 'Commenter' },
                { key: 'drive_item', label: 'Document' },
            ],
        },
    ],
} satisfies AutomationDefinitions<TextSchema>

export default automation
