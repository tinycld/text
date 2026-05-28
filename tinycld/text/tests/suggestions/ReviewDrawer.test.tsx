// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ReviewDrawer } from '~/tinycld/text/components/suggestions/ReviewDrawer'
import { createReviewDrawerStore } from '~/tinycld/text/stores/review-drawer-store'

describe('ReviewDrawer', () => {
    // RTL's auto-cleanup hook isn't wired through our shared
    // vitest setup, so each render leaves DOM nodes behind that
    // the next test's queries can match. Clear manually.
    afterEach(() => cleanup())

    it('renders null when the drawer is closed for this document', () => {
        const store = createReviewDrawerStore()
        // store starts closed
        const { container } = render(
            <ReviewDrawer
                driveItemId="di_1"
                store={store}
                anchored={[]}
                orphaned={[]}
                canResolve={false}
                onAccept={() => {}}
                onReject={() => {}}
                onBulkAccept={() => {}}
                onBulkReject={() => {}}
                onJump={() => {}}
                isPending={false}
            />
        )
        expect(container.firstChild).toBeNull()
    })

    it('renders null when the drawer is open for a different document', () => {
        const store = createReviewDrawerStore()
        store.getState().open('di_OTHER')
        const { container } = render(
            <ReviewDrawer
                driveItemId="di_1"
                store={store}
                anchored={[]}
                orphaned={[]}
                canResolve={false}
                onAccept={() => {}}
                onReject={() => {}}
                onBulkAccept={() => {}}
                onBulkReject={() => {}}
                onJump={() => {}}
                isPending={false}
            />
        )
        expect(container.firstChild).toBeNull()
    })

    it('renders the open suggestions list when the drawer is open', () => {
        const store = createReviewDrawerStore()
        store.getState().open('di_1')
        render(
            <ReviewDrawer
                driveItemId="di_1"
                store={store}
                anchored={[
                    {
                        id: 's1',
                        status: 'open',
                        authorId: 'uo_alice',
                        ts: 1000,
                        kind: 'insert',
                        anchorRange: { from: 1, to: 5 },
                        snippet: 'inserted',
                    },
                ]}
                orphaned={[]}
                canResolve
                onAccept={() => {}}
                onReject={() => {}}
                onBulkAccept={() => {}}
                onBulkReject={() => {}}
                onJump={() => {}}
                isPending={false}
            />
        )
        expect(screen.getByText(/inserted/i)).toBeTruthy()
    })

    it('Accept all / Reject all buttons are hidden when canResolve is false', () => {
        const store = createReviewDrawerStore()
        store.getState().open('di_1')
        render(
            <ReviewDrawer
                driveItemId="di_1"
                store={store}
                anchored={[
                    {
                        id: 's1',
                        status: 'open',
                        authorId: 'uo_alice',
                        ts: 1000,
                        kind: 'insert',
                        anchorRange: { from: 1, to: 5 },
                        snippet: 'inserted',
                    },
                ]}
                orphaned={[]}
                canResolve={false}
                onAccept={() => {}}
                onReject={() => {}}
                onBulkAccept={() => {}}
                onBulkReject={() => {}}
                onJump={() => {}}
                isPending={false}
            />
        )
        expect(screen.queryByText(/accept all/i)).toBeNull()
        expect(screen.queryByText(/reject all/i)).toBeNull()
    })

    it('renders the empty state when there are no suggestions', () => {
        const store = createReviewDrawerStore()
        store.getState().open('di_1')
        render(
            <ReviewDrawer
                driveItemId="di_1"
                store={store}
                anchored={[]}
                orphaned={[]}
                canResolve
                onAccept={() => {}}
                onReject={() => {}}
                onBulkAccept={() => {}}
                onBulkReject={() => {}}
                onJump={() => {}}
                isPending={false}
            />
        )
        expect(screen.getByText(/no suggestions/i)).toBeTruthy()
    })

    it('renders an orphaned section when there are orphaned suggestions', () => {
        const store = createReviewDrawerStore()
        store.getState().open('di_1')
        render(
            <ReviewDrawer
                driveItemId="di_1"
                store={store}
                anchored={[]}
                orphaned={[
                    {
                        id: 's-orphan',
                        status: 'open',
                        authorId: 'uo_gone',
                        ts: 500,
                    },
                ]}
                canResolve
                onAccept={() => {}}
                onReject={() => {}}
                onBulkAccept={() => {}}
                onBulkReject={() => {}}
                onJump={() => {}}
                isPending={false}
            />
        )
        expect(screen.getByText(/orphaned/i)).toBeTruthy()
    })
})
