// formatRelative renders a UNIX-millis timestamp as a human-friendly
// "N minutes ago" style string. Handles the just-now / minute / hour /
// day buckets. We deliberately avoid Intl.RelativeTimeFormat here —
// activity rows render densely, so the explicit bucketing keeps the
// strings short ("3 minutes ago" vs. "3 minutes ago" + locale-specific
// quirks) and predictable.
//
// Extracted from ActivityTab.tsx in Phase 5 (suggestion-threads Task 3)
// so the suggestion reply list — and any future feed-style row — can
// reuse the exact same bucketing without duplicating the boundaries.
export function formatRelative(ts: number): string {
    const minutes = Math.floor((Date.now() - ts) / 60_000)
    if (minutes < 1) return 'just now'
    if (minutes === 1) return '1 minute ago'
    if (minutes < 60) return `${minutes} minutes ago`
    const hours = Math.floor(minutes / 60)
    if (hours === 1) return '1 hour ago'
    if (hours < 24) return `${hours} hours ago`
    const days = Math.floor(hours / 24)
    return `${days} day${days === 1 ? '' : 's'} ago`
}
