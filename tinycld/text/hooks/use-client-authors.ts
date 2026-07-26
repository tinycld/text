import { useMemo, useSyncExternalStore } from 'react'
import type * as Y from 'yjs'

// EMPTY is a stable identity returned by the no-op bridge (null yDoc)
// so React's useSyncExternalStore doesn't see a fresh reference on
// every render and log the "result of getSnapshot should be cached to
// avoid an infinite loop" warning.
const EMPTY: Map<number, string> = new Map()

interface ClientAuthorsBridge {
    getSnapshot: () => Map<number, string>
    subscribe: (handler: () => void) => () => void
}

// createClientAuthorsBridge produces a bridge backed directly by the
// doc's `clientAuthors` Y.Map (Yjs clientID stringified-decimal → user
// org ID). Pure-function helper for tests; the hook below wraps it
// with React lifecycle.
//
// When yDoc is null returns a no-op bridge that yields an empty
// snapshot and a stub unsubscribe.
//
// The non-empty branch caches the most recently computed snapshot and
// recomputes only when the Y.Map's observe callback runs.
// useSyncExternalStore reads getSnapshot on every render and requires
// the reference to be stable across renders when nothing changed —
// without the cache, React dev mode logs the infinite-loop warning.
// The dirty flag is cleared in the subscribe callback BEFORE handler()
// fires so the next getSnapshot recomputes against fresh state.
//
// Keys in the Y.Map are stringified decimal Yjs clientIDs; the bridge
// parses them back to numbers via Number(key) and drops any NaN keys
// defensively (the writer in Phase 3a always stamps numeric strings,
// but we don't want a stray malformed entry to throw at render time).
export function createClientAuthorsBridge(yDoc: Y.Doc | null): ClientAuthorsBridge {
    if (yDoc === null) {
        return {
            getSnapshot: () => EMPTY,
            subscribe: () => () => {},
        }
    }
    const map = yDoc.getMap<string>('clientAuthors')
    let cached: Map<number, string> | null = null
    const compute = (): Map<number, string> => {
        const out = new Map<number, string>()
        map.forEach((value, key) => {
            const n = Number(key)
            if (!Number.isNaN(n)) out.set(n, value)
        })
        return out
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
            map.observe(listener)
            return () => {
                map.unobserve(listener)
            }
        },
    }
}

// useClientAuthors subscribes to the `clientAuthors` Y.Map on the
// supplied doc and returns a Map<number, string> from Yjs clientID to
// user ID. The bridge identity is memoized on the yDoc reference
// so React's useSyncExternalStore sees stable subscribe / getSnapshot
// functions across renders.
export function useClientAuthors(yDoc: Y.Doc | null): Map<number, string> {
    const bridge = useMemo(() => createClientAuthorsBridge(yDoc), [yDoc])
    return useSyncExternalStore(bridge.subscribe, bridge.getSnapshot)
}
