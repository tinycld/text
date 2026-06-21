import type { AnchoredSuggestion } from '../../hooks/use-document-suggestions'

// SuggestionRow is platform-resolved: SuggestionRow.web.tsx renders
// the static header + inline focused-state body (the discussion thread
// shows underneath the row when isFocused). SuggestionRow.native.tsx
// renders ONLY the header — the focused-state body lives in a
// screen-scoped <SuggestionThreadSheet /> bottom sheet on native.
//
// This .d.ts mirrors the use-suggestion-bridge pattern: Metro and the
// vitest resolver pick the right .web.tsx / .native.tsx variant via
// their platform-extensions resolvers, but plain `tsc` doesn't follow
// those — without a type-side resolution entry, every import of
// `./SuggestionRow` would error TS2307. The runtime variants both
// export an identical `SuggestionRow` and `SuggestionRowProps` shape
// so the declared types here line up with whichever variant the
// bundler loads.
export interface SuggestionRowProps {
    suggestion: AnchoredSuggestion
    driveItemId: string
    authorUserOrgId: string
    isFocused: boolean
    canResolve: boolean
    isPending: boolean
    onAccept: () => void
    onReject: () => void
    onFocus: () => void
    onJump?: () => void
}

export function SuggestionRow(props: SuggestionRowProps): JSX.Element
