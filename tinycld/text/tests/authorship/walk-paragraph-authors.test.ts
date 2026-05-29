// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { walkParagraphAuthors } from '~/tinycld/text/lib/authorship/walk-paragraph-authors'

// Helper: build the canonical YXmlFragment → YXmlElement('paragraph')
// → YXmlText nesting the editor uses, and return the inner YXmlText.
// Avoids polluting each test with the same boilerplate.
function makeParagraph(doc: Y.Doc): Y.XmlText {
    const frag = doc.getXmlFragment('default')
    const paragraph = new Y.XmlElement('paragraph')
    const text = new Y.XmlText()
    paragraph.insert(0, [text])
    frag.insert(0, [paragraph])
    return text
}

describe('walkParagraphAuthors', () => {
    it('returns a single run spanning the full text when one author wrote it', () => {
        const doc = new Y.Doc()
        // Pin the clientID so the authors map lookup is deterministic.
        doc.clientID = 42
        const text = makeParagraph(doc)
        text.insert(0, 'hello world')

        const authors = new Map<number, string>([[42, 'uo-A']])
        const runs = walkParagraphAuthors(text, authors)

        expect(runs).toEqual([{ authorId: 'uo-A', from: 0, to: 11 }])
    })

    it('returns separate runs when two distinct clientIDs contributed', () => {
        // Doc A writes "hello ", syncs to B, B appends "world" at the
        // end, then B's update flows back to A. After the merge, A's
        // YText contains two items: one stamped with clientID A, one
        // with clientID B.
        const docA = new Y.Doc()
        docA.clientID = 1
        const fragA = docA.getXmlFragment('default')
        const paragraphA = new Y.XmlElement('paragraph')
        const textA = new Y.XmlText()
        paragraphA.insert(0, [textA])
        fragA.insert(0, [paragraphA])
        textA.insert(0, 'hello ')

        const docB = new Y.Doc()
        docB.clientID = 2
        Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))
        const fragB = docB.getXmlFragment('default')
        const paragraphB = fragB.get(0) as Y.XmlElement
        const textB = paragraphB.get(0) as Y.XmlText
        textB.insert(6, 'world')

        Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB))

        const authors = new Map<number, string>([
            [1, 'uo-A'],
            [2, 'uo-B'],
        ])
        const runs = walkParagraphAuthors(textA, authors)

        expect(runs).toEqual([
            { authorId: 'uo-A', from: 0, to: 6 },
            { authorId: 'uo-B', from: 6, to: 11 },
        ])
    })

    it('skips tombstoned items so offsets reflect post-delete positions', () => {
        const doc = new Y.Doc()
        doc.clientID = 7
        const text = makeParagraph(doc)
        text.insert(0, 'abcdef')
        // Delete "cd" at indices 2-3 (length 2). Surviving text is
        // "abef" (length 4); the walker should emit a run from 0..4
        // since the deleted middle items advance neither the offset nor
        // close the run.
        text.delete(2, 2)

        const authors = new Map<number, string>([[7, 'uo-X']])
        const runs = walkParagraphAuthors(text, authors)

        expect(runs).toEqual([{ authorId: 'uo-X', from: 0, to: 4 }])
        expect(text.toString()).toBe('abef')
    })

    it('returns an empty array for an empty paragraph', () => {
        const doc = new Y.Doc()
        const text = makeParagraph(doc)

        const runs = walkParagraphAuthors(text, new Map())

        expect(runs).toEqual([])
    })
})
