import { asyncStorage, create, persist } from '@tinycld/core/lib/store'

// Per-user UI preference governing whether the editor colors each
// text run by its author. Persisted via asyncStorage so the choice
// survives reloads on the same device — there is no PocketBase
// collection for arbitrary user-UI prefs, so device-scoped persistence
// is the accepted v1 trade-off (mirrors how mail's compose store and
// drive's UI stores persist their toggles).
interface AuthorshipDisplayState {
    coloringEnabled: boolean
    setColoringEnabled: (b: boolean) => void
}

export const useAuthorshipDisplayStore = create<AuthorshipDisplayState>()(
    persist(
        set => ({
            coloringEnabled: false,
            setColoringEnabled: b => set({ coloringEnabled: b }),
        }),
        {
            name: 'tinycld_authorship_display',
            storage: asyncStorage,
            partialize: s => ({ coloringEnabled: s.coloringEnabled }),
        }
    )
)
