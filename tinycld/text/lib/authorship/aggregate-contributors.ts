import * as Y from 'yjs'
import { walkParagraphAuthors } from './walk-paragraph-authors'

export interface ContributorSummary {
    authorId: string | null
    charCount: number
    // 0-100, rounded
    percent: number
}

// aggregateContributors walks the entire Y.XmlFragment (the editor's
// root) and sums per-author character counts across every Y.XmlText it
// encounters, then computes percentages of the doc's current (post-
// delete) length. Deleted items are ignored — this reflects what's in
// the document NOW, not historical contribution.
//
// The fragment structure mirrors the editor's TipTap schema:
//   Fragment → XmlElement('paragraph' | 'heading' | …) → XmlText
// So in the common case there is exactly one level of nesting between
// the fragment and the text leaves. The traversal is generalised to
// arbitrary nesting (recursing through any XmlElement) so things like
// blockquotes or list items containing nested paragraphs are handled.
//
// Empty fragment → empty array.
// Fragment with only anonymous authors → one entry with authorId: null.
export function aggregateContributors(
    yFragment: Y.XmlFragment,
    clientAuthors: Map<number, string>
): ContributorSummary[] {
    const totals = new Map<string | null, number>()
    let grandTotal = 0

    const visit = (node: unknown): void => {
        if (node instanceof Y.XmlText) {
            const runs = walkParagraphAuthors(node, clientAuthors)
            for (const r of runs) {
                const len = r.to - r.from
                totals.set(r.authorId, (totals.get(r.authorId) ?? 0) + len)
                grandTotal += len
            }
            return
        }
        if (node instanceof Y.XmlElement || node instanceof Y.XmlFragment) {
            node.forEach((child) => visit(child))
        }
    }

    yFragment.forEach((child) => visit(child))

    const out: ContributorSummary[] = []
    for (const [authorId, charCount] of totals.entries()) {
        out.push({
            authorId,
            charCount,
            percent:
                grandTotal > 0 ? Math.round((charCount / grandTotal) * 100) : 0,
        })
    }
    out.sort((a, b) => b.charCount - a.charCount)
    return out
}
