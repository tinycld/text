import { ulid } from 'ulid'

const IDLE_TIMEOUT_MS = 30_000

export interface SuggestionSession {
    // touch records a user-driven edit and returns the suggestionId
    // that should be stamped on it. Returns the same id across rapid
    // edits (within IDLE_TIMEOUT_MS) and a fresh ulid after the idle
    // window elapses.
    touch: () => string
    // current returns the currently-active suggestionId without
    // extending the idle window. Useful for the popover / sidebar to
    // ask "is the author still actively editing this suggestion?"
    // Returns null if no active session OR if the idle window has
    // elapsed since the last touch. Side effect: when the window has
    // elapsed, the session is internally cleared on this call, so
    // subsequent calls also return null until the next touch().
    current: () => string | null
    // reset drops the active suggestionId. Called when the user
    // explicitly exits suggest mode (so the next touch in suggest
    // mode mints a fresh id).
    reset: () => void
}

// createSuggestionSession is one-per-(user, document). The authorId
// is captured at construction for symmetry with the data model — the
// session itself only mints ulids, but having the authorId on hand
// makes the call site (command-layer) less error-prone.
//
// The session drives Date.now() directly rather than using setTimeout.
// Two reasons:
//   1. Tests deterministically advance virtual time with
//      vi.useFakeTimers() + vi.advanceTimersByTime().
//   2. No dangling-timer leak risk on editor unmount (there are no
//      timers to clean up).
//
// Trade-off: idle expiry is detected lazily on the next call. A long
// idle period followed by a current() returns null correctly; the
// store doesn't proactively notify subscribers that the session
// expired. Phase 2a doesn't need such a notification — the popover
// and sidebar both read current() on render, not via a subscription.
export function createSuggestionSession(authorId: string): SuggestionSession {
    let activeId: string | null = null
    let lastTouch = 0

    const touch = () => {
        const now = Date.now()
        if (activeId === null || now - lastTouch > IDLE_TIMEOUT_MS) {
            activeId = ulid()
        }
        lastTouch = now
        return activeId
    }

    const current = () => {
        if (activeId === null) return null
        if (Date.now() - lastTouch > IDLE_TIMEOUT_MS) {
            activeId = null
            return null
        }
        return activeId
    }

    const reset = () => {
        activeId = null
        lastTouch = 0
    }

    // authorId is referenced via closure for the spec's documentation
    // contract; not all consumers need it as a separate output, but
    // it's part of the per-session identity.
    void authorId

    return { touch, current, reset }
}
