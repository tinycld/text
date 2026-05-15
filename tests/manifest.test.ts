import { describe, expect, it } from 'vitest'
import manifest from '../manifest'

describe('text manifest', () => {
    it('declares required identifiers', () => {
        expect(manifest.name).toBe('Text')
        expect(manifest.slug).toBe('text')
        expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/)
    })

    it('has a description', () => {
        expect(manifest.description).toBe('Plain-text and rich-text documents.')
    })
})
