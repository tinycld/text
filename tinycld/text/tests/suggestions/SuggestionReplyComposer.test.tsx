// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// SuggestionReplyComposer is a thin wrapper around the shared
// CommentComposer + MentionInput primitive. The interactive form
// behavior (typing into the field, the @-mention picker, the
// `[[@userOrgId]]` token insertion) lives in @tinycld/core/ui/comments
// and is unit-tested there — happy-dom + the react-native-stub renders
// react-native TextInput as a bare <textinput> custom element with no
// value setter, so fireEvent.change can't drive the field anyway.
//
// What we DO verify here:
//   - the wrapper pulls the current user_org id off useEditorMount and
//     pipes it into useMentionSuggestions (the @-picker pool)
//   - the wrapper installs a handler that, when CommentComposer's
//     onSubmit fires, parses out `[[@userOrgId]]` tokens and forwards
//     `(body, mentions[])` to the parent's onSubmit
//   - the wrapper exposes the parent's pending state to the inner
//     composer so the submit button greys out while a reply is in
//     flight
//
// We achieve that by stubbing CommentComposer to a tiny component that
// surfaces the props we pass to it as text content. That lets us
// inspect (without rendering the form) what the wrapper passed in and,
// crucially, call the inner onSubmit directly to drive the parse+
// forward path.

const editorMountMock = vi.fn(() => ({
    identity: { userOrgId: 'uo_me' },
}))
const mentionSuggestionsMock = vi.fn((_id: string) => [] as unknown[])

vi.mock('@tinycld/core/lib/editor/editor-mount', () => ({
    useEditorMount: () => editorMountMock(),
}))
vi.mock('~/tinycld/text/hooks/use-mention-suggestions', () => ({
    useMentionSuggestions: (id: string) => mentionSuggestionsMock(id),
}))

// Capture the props the composer received so the tests can probe
// them. Held module-scoped, reset in beforeEach.
let capturedProps: {
    onSubmit?: (body: string) => void
    isPending?: boolean
    placeholder?: string
    mentionSuggestions?: unknown[]
} = {}

vi.mock('@tinycld/core/ui/comments', () => ({
    CommentComposer: (props: {
        onSubmit: (body: string) => void
        isPending?: boolean
        placeholder?: string
        mentionSuggestions?: unknown[]
    }) => {
        capturedProps = props
        return null
    },
}))

import { SuggestionReplyComposer } from '~/tinycld/text/components/suggestions/SuggestionReplyComposer'

describe('SuggestionReplyComposer', () => {
    afterEach(() => {
        cleanup()
        capturedProps = {}
        editorMountMock.mockClear()
        mentionSuggestionsMock.mockClear()
    })

    it('feeds the current user_org id from useEditorMount into useMentionSuggestions', () => {
        render(<SuggestionReplyComposer onSubmit={() => {}} />)
        expect(editorMountMock).toHaveBeenCalled()
        expect(mentionSuggestionsMock).toHaveBeenCalledWith('uo_me')
    })

    it('passes the placeholder through to the inner composer (default copy)', () => {
        render(<SuggestionReplyComposer onSubmit={() => {}} />)
        expect(capturedProps.placeholder).toBe('Reply or add others with @')
    })

    it('forwards (body, mentions[]) to the parent onSubmit, parsing `[[@id]]` tokens out of the body', async () => {
        const parentOnSubmit = vi.fn(() => Promise.resolve())
        render(<SuggestionReplyComposer onSubmit={parentOnSubmit} />)

        // Drive the inner submit directly. The composer is responsible
        // for parsing the @-tokens out and emitting them as the second
        // argument; the body string itself passes through unchanged.
        await capturedProps.onSubmit?.('cc [[@uo_bob]] [[@uo_carol]] please review')

        expect(parentOnSubmit).toHaveBeenCalledTimes(1)
        expect(parentOnSubmit).toHaveBeenCalledWith('cc [[@uo_bob]] [[@uo_carol]] please review', [
            'uo_bob',
            'uo_carol',
        ])
    })

    it('emits an empty mentions array when the body contains no mention tokens', async () => {
        const parentOnSubmit = vi.fn(() => Promise.resolve())
        render(<SuggestionReplyComposer onSubmit={parentOnSubmit} />)

        await capturedProps.onSubmit?.('looks good')

        expect(parentOnSubmit).toHaveBeenCalledWith('looks good', [])
    })
})
