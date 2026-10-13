// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LinkPopover } from '../tinycld/text/components/LinkPopover'
import { INVALID_LINK_ERROR } from '../tinycld/text/components/link-url-schema'

function renderPopover(initialUrl = '') {
    const onInsert = vi.fn()
    const view = render(
        <LinkPopover isOpen initialUrl={initialUrl} onCancel={() => {}} onInsert={onInsert} />
    )
    const input = view.container.querySelector<HTMLInputElement>('rn-textinput')
    if (!input) throw new Error('no input rendered')
    return { ...view, input, onInsert }
}

async function typeAndInsert(view: ReturnType<typeof renderPopover>, value: string) {
    await act(async () => {
        fireEvent.input(view.input, { target: { value } })
    })
    await act(async () => {
        fireEvent.click(view.getByText('Insert'))
    })
}

describe('LinkPopover form', () => {
    afterEach(cleanup)

    it('inserts a bare domain with an https:// prefix', async () => {
        const view = renderPopover()
        await typeAndInsert(view, ' example.com ')
        expect(view.onInsert).toHaveBeenCalledWith('https://example.com')
    })

    it('inserts an empty url so the caller removes the link', async () => {
        const view = renderPopover('https://example.com')
        await typeAndInsert(view, '')
        expect(view.onInsert).toHaveBeenCalledWith('')
    })

    it('shows an error and does not insert an invalid link', async () => {
        const view = renderPopover()
        await typeAndInsert(view, 'not a link')
        expect(view.onInsert).not.toHaveBeenCalled()
        expect(view.getByText(INVALID_LINK_ERROR)).toBeTruthy()
    })
})
