import { useMemo, useSyncExternalStore } from 'react'
import type * as Y from 'yjs'
import type { EditEvent } from '../webview-editor/source/suggestions/suggestion-types'
import { parseEditEvent } from './parse-edit-events'

// EMPTY is a stable identity returned by the no-op bridge (null yDoc)
// so React's useSyncExternalStore doesn't see a fresh reference on
// every render and log the "result of getSnapshot should be cached to
// avoid an infinite loop" warning.
const EMPTY: EditEvent[] = []

interface EditEventsBridge {
    getSnapshot: () => EditEvent[]
    subscribe: (handler: () => void) => () => void
}

// createEditEventsBridge produces a bridge backed directly by the
// doc's `editEvents` Y.Array. Pure-function helper for tests; the hook
// below wraps it with React lifecycle.
//
// When yDoc is null returns a no-op bridge that yields an empty
// snapshot and a stub unsubscribe.
//
// The non-empty branch caches the most recently computed snapshot and
// recomputes only when the Y.Array's observe callback runs.
// useSyncExternalStore reads getSnapshot on every render and requires
// the reference to be stable across renders when nothing changed —
// without the cache, React dev mode logs the infinite-loop warning.
// The dirty flag is set in the subscribe callback BEFORE handler()
// fires so the next getSnapshot recomputes against fresh state.
export function createEditEventsBridge(yDoc: Y.Doc | null): EditEventsBridge {
    if (yDoc === null) {
        return {
            getSnapshot: () => EMPTY,
            subscribe: () => () => {},
        }
    }
    const arr = yDoc.getArray<unknown>('editEvents')
    let cached: EditEvent[] | null = null
    const compute = (): EditEvent[] => {
        const events: EditEvent[] = []
        arr.forEach(raw => {
            const parsed = parseEditEvent(raw)
            if (parsed !== null) events.push(parsed)
        })
        events.sort((a, b) => b.endedAt - a.endedAt)
        return events
    }
    return {
        getSnapshot: () => {
            if (cached === null) cached = compute()
            return cached
        },
        subscribe: handler => {
            const listener = () => {
                cached = null
                handler()
            }
            arr.observe(listener)
            return () => {
                arr.unobserve(listener)
            }
        },
    }
}

// useEditEvents subscribes to the `editEvents` Y.Array on the supplied
// doc and returns the parsed events sorted by endedAt descending. The
// bridge identity is memoized on the yDoc reference so React's
// useSyncExternalStore sees stable subscribe / getSnapshot functions
// across renders.
export function useEditEvents(yDoc: Y.Doc | null): EditEvent[] {
    const bridge = useMemo(() => createEditEventsBridge(yDoc), [yDoc])
    return useSyncExternalStore(bridge.subscribe, bridge.getSnapshot)
}
