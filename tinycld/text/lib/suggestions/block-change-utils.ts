import type { Node as PMNode } from '@tiptap/pm/model'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { AttrStep, ReplaceAroundStep, ReplaceStep } from '@tiptap/pm/transform'

// A BlockChange is one detected block-level transformation in a user
// transaction. The command-layer rewrites these into suggestedBlockChange
// node attributes (and, for kind='delete', companion suggestedDelete
// marks on the inline content) when in suggesting mode.
//
// All positions are expressed in the ORIGINAL (pre-transaction) doc's
// coordinates. The command-layer maps them through its own appended
// transaction's mapping as needed when stamping the attribute.
export type BlockChange =
    | {
          kind: 'attr'
          pos: number
          beforeType: string
          beforeAttrs: Record<string, unknown>
          afterType: string
          afterAttrs: Record<string, unknown>
      }
    | {
          kind: 'type-swap'
          pos: number
          beforeType: string
          beforeAttrs: Record<string, unknown>
          afterType: string
          afterAttrs: Record<string, unknown>
      }
    | {
          kind: 'delete'
          pos: number
          beforeType: string
          beforeAttrs: Record<string, unknown>
      }

// The block-level node types the detector recognizes. Mirrors the
// SuggestedBlockChange extension's TARGET_NODE_TYPES (paragraph,
// heading, listItem, blockquote, tableCell). Nodes outside this set
// are not considered "blocks" for the purposes of block-change
// detection — text-level changes inside them are handled by the
// insert/delete/format-change paths.
const TARGET_BLOCK_TYPES = new Set([
    'paragraph',
    'heading',
    'listItem',
    'blockquote',
    'tableCell',
])

// extractBlockChanges walks a user transaction's steps and returns one
// BlockChange entry per affected block. Same-block multi-step
// transactions (e.g. setBlockType followed by setNodeAttribute on the
// same block) collapse to a single entry — later steps overwrite
// earlier ones at the same pos.
//
// Text-only edits (typing, deleting inside a block, mark toggles) are
// IGNORED here — those paths are handled by the format-change and
// insert/delete branches of the command layer. The detector only fires
// when the user changes a block's TYPE, its ATTRIBUTES, or removes an
// entire block from the doc.
//
// Implementation notes:
//   - AttrStep with pos at a block-level node → kind='attr' (when the
//     attribute being set is not the suggestion-tracking
//     suggestedBlockChange attribute itself, which would re-enter the
//     command layer on resolve).
//   - ReplaceAroundStep where the slice's first child is a different
//     node type than the original at pos → kind='type-swap'. When the
//     types match but attrs differ, we record kind='attr' (setNodeMarkup
//     with the same type but different attrs takes this path).
//   - ReplaceStep where the deleted range fully encloses one or more
//     block nodes and the inserted slice is empty → kind='delete' per
//     enclosed block.
//
// Because the command-layer maps detected positions through its own
// emitted transaction, we look up beforeType/beforeAttrs directly from
// originalState.doc — never from intermediate states.
export function extractBlockChanges(
    tr: Transaction,
    originalState: EditorState
): BlockChange[] {
    // Collect by pos so same-block multi-step transactions collapse.
    // Later steps overwrite earlier entries at the same key.
    const byPos = new Map<number, BlockChange>()

    for (const step of tr.steps) {
        if (step instanceof AttrStep) {
            handleAttrStep(step, originalState, byPos)
        } else if (step instanceof ReplaceAroundStep) {
            handleReplaceAroundStep(step, originalState, byPos)
        } else if (step instanceof ReplaceStep) {
            handleReplaceStepDelete(step, originalState, byPos)
        }
    }

    // Return in ascending position order — callers iterate this list
    // back-to-front when applying to keep positions stable.
    return Array.from(byPos.values()).sort((a, b) => a.pos - b.pos)
}

function handleAttrStep(
    step: AttrStep,
    originalState: EditorState,
    byPos: Map<number, BlockChange>
): void {
    // The command layer's own resolve writes hit suggestedBlockChange
    // directly — ignore those so a resolve doesn't loop back into a
    // fresh block-change detection.
    if (step.attr === 'suggestedBlockChange') return

    const node = originalState.doc.nodeAt(step.pos)
    if (!node) return
    if (!TARGET_BLOCK_TYPES.has(node.type.name)) return

    const beforeAttrs = { ...node.attrs }
    const afterAttrs = { ...beforeAttrs, [step.attr]: step.value }
    byPos.set(step.pos, {
        kind: 'attr',
        pos: step.pos,
        beforeType: node.type.name,
        beforeAttrs,
        afterType: node.type.name,
        afterAttrs,
    })
}

function handleReplaceAroundStep(
    step: ReplaceAroundStep,
    originalState: EditorState,
    byPos: Map<number, BlockChange>
): void {
    // setBlockType / setNodeMarkup emit a ReplaceAroundStep that
    // wraps the original block's inner content with a new opening +
    // closing token. The slice's first child is the new node with its
    // new type + attrs; the original block lives at step.from in the
    // pre-step doc.
    const beforeNode = originalState.doc.nodeAt(step.from)
    if (!beforeNode) return
    if (!TARGET_BLOCK_TYPES.has(beforeNode.type.name)) return

    const newOpening = step.slice.content.firstChild
    if (!newOpening) return
    if (!TARGET_BLOCK_TYPES.has(newOpening.type.name)) return

    const beforeAttrs = { ...beforeNode.attrs }
    const afterAttrs = { ...newOpening.attrs }
    if (beforeNode.type.name === newOpening.type.name) {
        // Same type, different attrs — record as kind='attr' so the
        // resolver can clear via setNodeMarkup without changing type.
        byPos.set(step.from, {
            kind: 'attr',
            pos: step.from,
            beforeType: beforeNode.type.name,
            beforeAttrs,
            afterType: newOpening.type.name,
            afterAttrs,
        })
        return
    }
    byPos.set(step.from, {
        kind: 'type-swap',
        pos: step.from,
        beforeType: beforeNode.type.name,
        beforeAttrs,
        afterType: newOpening.type.name,
        afterAttrs,
    })
}

function handleReplaceStepDelete(
    step: ReplaceStep,
    originalState: EditorState,
    byPos: Map<number, BlockChange>
): void {
    // We only treat ReplaceStep as a block-delete when the deleted
    // range fully encloses one or more block-level nodes AND the
    // inserted slice is empty. Text-only deletes (delete a character
    // inside a paragraph) fall through to the existing delete path in
    // the command-layer.
    if (step.slice.content.size > 0) return

    // Walk the original doc within [step.from, step.to) and collect
    // every block-level node fully contained in that range. For a
    // block to count as "fully deleted", both its opening token
    // (position == nodePos) and its closing token (nodePos + nodeSize
    // == ...) must lie within [step.from, step.to].
    const fullyDeleted: Array<{ pos: number; node: PMNode }> = []
    originalState.doc.nodesBetween(step.from, step.to, (node, nodePos) => {
        if (!TARGET_BLOCK_TYPES.has(node.type.name)) return true
        const startsInside = nodePos >= step.from
        const endsInside = nodePos + node.nodeSize <= step.to
        if (startsInside && endsInside) {
            fullyDeleted.push({ pos: nodePos, node })
            // Don't descend into a block that's already accounted
            // for — its children are deleted as part of the block.
            return false
        }
        return true
    })

    for (const { pos, node } of fullyDeleted) {
        byPos.set(pos, {
            kind: 'delete',
            pos,
            beforeType: node.type.name,
            beforeAttrs: { ...node.attrs },
        })
    }
}
