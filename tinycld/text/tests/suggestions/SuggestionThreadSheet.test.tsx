// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { View } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'

// SuggestionThreadSheet only renders on native (Platform.OS !== 'web').
// vitest's default react-native stub reports Platform.OS as 'web' so we
// override it for this file. The mock has to be hoisted ABOVE the
// SuggestionThreadSheet import; vi.mock factories run before imports
// regardless of source position, but stating the dependencies near the
// top still keeps the file readable.
vi.mock('react-native', async () => {
    const actual = await vi.importActual<typeof import('react-native')>('react-native')
    return {
        ...actual,
        Platform: { ...actual.Platform, OS: 'ios' },
    }
})

// @tinycld/core/ui/bottom-drawer pulls in react-native-reanimated,
// react-native-gesture-handler and react-native-safe-area-context, none of
// which load in this happy-dom unit env. Stub it down to a plain View that
// honors isOpen so the sheet's open/closed contract is still observable
// through findThread() below.
vi.mock('@tinycld/core/ui/bottom-drawer', () => ({
    BottomDrawer: ({ isOpen, children }: { isOpen: boolean; children?: ReactNode }) =>
        isOpen ? <View>{children}</View> : null,
}))

// The sheet renders <SuggestionThread />, which mounts <SuggestionThread
// />'s composer + reply list. Those subcomponents pull from
// useEditorMount / useMentionSuggestions / the shared CommentComposer /
// useSuggestionDiscussion — same set of stubs the SuggestionRow phase-5
// test file installs.
vi.mock('~/tinycld/text/hooks/use-author-name', () => ({
    useAuthorName: () => null,
}))
vi.mock('@tinycld/core/lib/editor/editor-mount', () => ({
    useEditorMount: () => ({ identity: { userOrgId: 'uo_me' } }),
}))
vi.mock('~/tinycld/text/hooks/use-mention-suggestions', () => ({
    useMentionSuggestions: () => [],
}))
vi.mock('@tinycld/core/ui/comments', () => ({
    CommentComposer: () => null,
}))
vi.mock('~/tinycld/text/lib/suggestions/discussions', () => ({
    useSuggestionDiscussion: () => ({
        replies: [],
        addReply: async () => {},
        isLoading: false,
    }),
}))

import { SuggestionThreadSheet } from '~/tinycld/text/components/suggestions/SuggestionThreadSheet'
import type { AnchoredSuggestion } from '~/tinycld/text/hooks/use-document-suggestions'
import { createReviewDrawerStore } from '~/tinycld/text/stores/review-drawer-store'

const NOOP = () => {}

function sampleSuggestion(extra: Partial<AnchoredSuggestion> = {}): AnchoredSuggestion {
    return {
        id: 's1',
        status: 'open',
        authorId: 'uo_alice',
        ts: 1000,
        kind: 'insert',
        anchorRange: { from: 1, to: 5 },
        snippet: 'inserted text',
        ...extra,
    } as AnchoredSuggestion
}

function renderSheet(opts: {
    store: ReturnType<typeof createReviewDrawerStore>
    anchored: AnchoredSuggestion[]
    onAccept?: (id: string) => void
    onReject?: (id: string) => void
}) {
    return render(
        <SuggestionThreadSheet
            driveItemId="di_test"
            authorUserOrgId="uo_me"
            anchored={opts.anchored}
            canResolve
            isPending={false}
            onAccept={opts.onAccept ?? NOOP}
            onReject={opts.onReject ?? NOOP}
            store={opts.store}
        />
    )
}

// The BottomDrawer (mocked above) mounts its content tree only when
// isOpen is true. So "the sheet is open" is observable by checking
// whether the SuggestionThread testid is in the DOM; "the sheet is
// closed" is the absence of that testid.
function findThread(container: HTMLElement): Element | null {
    return container.querySelector('[data-testid="suggestion-thread"]')
}

describe('SuggestionThreadSheet', () => {
    afterEach(() => cleanup())

    it('renders nothing when focusedSuggestionId is null', () => {
        const store = createReviewDrawerStore()
        // store starts with focusedSuggestionId === null
        const { container } = renderSheet({
            store,
            anchored: [sampleSuggestion()],
        })
        // The sheet's BottomDrawer has isOpen=false → no thread mounted.
        expect(findThread(container)).toBeNull()
    })

    it('renders the thread body when focusedSuggestionId matches an anchored entry', () => {
        const store = createReviewDrawerStore()
        store.getState().open('di_test')
        store.getState().focusSuggestion('s1')

        const { container } = renderSheet({
            store,
            anchored: [sampleSuggestion({ id: 's1' })],
        })

        // <SuggestionThread /> carries data-testid="suggestion-thread"
        // on its root View — presence confirms the sheet mounted with
        // the focused suggestion's thread body inside.
        expect(findThread(container)).toBeTruthy()
    })

    it('renders nothing when focusedSuggestionId does not match any anchored entry (orphan)', () => {
        // Mirrors the post-orphan-auto-delete state: the focused id
        // is set but the row has been cleaned up from the bridge.
        const store = createReviewDrawerStore()
        store.getState().open('di_test')
        store.getState().focusSuggestion('s-gone')

        const { container } = renderSheet({
            store,
            anchored: [sampleSuggestion({ id: 's1' })],
        })

        expect(findThread(container)).toBeNull()
    })

    it('clears focusedSuggestionId via store.focusSuggestion(null) when the sheet dismisses', () => {
        // Dismissing the sheet (backdrop, swipe-down, or the header X)
        // routes through the same handleClose → store.focusSuggestion(null)
        // path. We don't have a way to simulate a real gesture in
        // happy-dom, so drive the store-level state machine directly:
        // call focusSuggestion(null) and verify the sheet unmounts.
        // This pins the contract "the sheet is bound to the store, so
        // any path that clears focusedSuggestionId unmounts the sheet"
        // without relying on a gluestack-internal event.
        const store = createReviewDrawerStore()
        store.getState().open('di_test')
        store.getState().focusSuggestion('s1')

        const { container } = renderSheet({
            store,
            anchored: [sampleSuggestion({ id: 's1' })],
        })

        expect(findThread(container)).toBeTruthy()

        // act() wraps the store mutation so React flushes the
        // subsequent re-render before the assertion below runs.
        // Without act() the focus-state change lands in zustand but
        // React's reconciler hasn't yet re-rendered the subscribed
        // component, and the thread node would still be in the DOM.
        act(() => {
            store.getState().focusSuggestion(null)
        })

        // The sheet's isOpen evaluates to false on the next render
        // (its `focused` lookup returns null), so the thread unmounts.
        expect(findThread(container)).toBeNull()
        expect(store.getState().focusedSuggestionId).toBeNull()
    })

    it('renders nothing on web (Platform.OS === "web")', async () => {
        // Reset modules so we can re-mock react-native with OS='web'
        // and re-import SuggestionThreadSheet against that variant.
        vi.resetModules()
        vi.doMock('react-native', async () => {
            const actual = await vi.importActual<typeof import('react-native')>('react-native')
            return {
                ...actual,
                Platform: { ...actual.Platform, OS: 'web' },
            }
        })
        const { SuggestionThreadSheet: WebSheet } = await import(
            '~/tinycld/text/components/suggestions/SuggestionThreadSheet'
        )
        const { createReviewDrawerStore: createStore } = await import(
            '~/tinycld/text/stores/review-drawer-store'
        )

        const store = createStore()
        store.getState().open('di_test')
        store.getState().focusSuggestion('s1')

        const { container } = render(
            <WebSheet
                driveItemId="di_test"
                authorUserOrgId="uo_me"
                anchored={[sampleSuggestion({ id: 's1' })]}
                canResolve
                isPending={false}
                onAccept={NOOP}
                onReject={NOOP}
                store={store}
            />
        )
        expect(container.firstChild).toBeNull()
        vi.doUnmock('react-native')
    })
})
