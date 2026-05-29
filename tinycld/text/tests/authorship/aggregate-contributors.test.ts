// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { aggregateContributors } from '~/tinycld/text/lib/authorship/aggregate-contributors'

// Helper: build a single paragraph nested under the canonical
// XmlFragment → XmlElement('paragraph') → XmlText structure. Returns
// the inner XmlText for the caller to fill in.
function makeParagraph(doc: Y.Doc): Y.XmlText {
    const frag = doc.getXmlFragment('default')
    const paragraph = new Y.XmlElement('paragraph')
    const text = new Y.XmlText()
    paragraph.insert(0, [text])
    frag.insert(frag.length, [paragraph])
    return text
}

describe('aggregateContributors', () => {
    it('returns a single 100% entry when one author wrote the whole doc', () => {
        const doc = new Y.Doc()
        doc.clientID = 42
        const text = makeParagraph(doc)
        text.insert(0, 'hello world')

        const authors = new Map<number, string>([[42, 'uo-A']])
        const summary = aggregateContributors(
            doc.getXmlFragment('default'),
            authors
        )

        expect(summary).toEqual([
            { authorId: 'uo-A', charCount: 11, percent: 100 },
        ])
    })

    it('splits 50/50 across two paragraphs of equal length by two authors', () => {
        // Mirror Task 2's two-client setup: A writes the first paragraph,
        // B (after syncing) writes a second paragraph of equal length.
        // After cross-merge each doc carries items stamped by both
        // clientIDs and the per-author char totals come out even.
        const docA = new Y.Doc()
        docA.clientID = 1
        const fragA = docA.getXmlFragment('default')
        const paragraphA = new Y.XmlElement('paragraph')
        const textA = new Y.XmlText()
        paragraphA.insert(0, [textA])
        fragA.insert(0, [paragraphA])
        textA.insert(0, 'aaaaa') // 5 chars by clientID 1

        const docB = new Y.Doc()
        docB.clientID = 2
        Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))
        const fragB = docB.getXmlFragment('default')
        const paragraphB = new Y.XmlElement('paragraph')
        const textB = new Y.XmlText()
        paragraphB.insert(0, [textB])
        fragB.insert(fragB.length, [paragraphB])
        textB.insert(0, 'bbbbb') // 5 chars by clientID 2

        Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB))

        const authors = new Map<number, string>([
            [1, 'uo-A'],
            [2, 'uo-B'],
        ])
        const summary = aggregateContributors(
            docA.getXmlFragment('default'),
            authors
        )

        expect(summary).toEqual([
            { authorId: 'uo-A', charCount: 5, percent: 50 },
            { authorId: 'uo-B', charCount: 5, percent: 50 },
        ])
    })

    it('returns an empty array for an empty fragment', () => {
        const doc = new Y.Doc()
        const summary = aggregateContributors(
            doc.getXmlFragment('default'),
            new Map()
        )

        expect(summary).toEqual([])
    })
})
