import type { ReactNode } from 'react'

// Optional context provider mounted by core inside /a/[orgSlug]/text.
// Wrap any package-specific context providers or run mount-time side
// effects (e.g. subscribing to events, prefetching queries) here.
//
// If you don't need a provider, delete this file and remove the
// `provider` field from manifest.ts.

interface Props {
    children: ReactNode
}

export default function TextProvider({ children }: Props) {
    return <>{children}</>
}
