// Slash-menu popover is web-only in v1 — the suggestion plugin lives
// inside the web Tiptap editor, and the native variant of
// use-document-editor renders a "coming soon" placeholder. This stub
// keeps the screen's `import { SlashMenu } from '../components/SlashMenu'`
// resolvable on iOS/Android so the bundler doesn't crash; Metro picks
// up the `.web.tsx` sibling for the actual UI on web.
export function SlashMenu(): null {
    return null
}
