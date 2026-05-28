import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import type { Editor } from '@tiptap/core'
import type { LucideIcon } from 'lucide-react-native'
import { useEffect, useMemo, useReducer } from 'react'
import { createPortal } from 'react-dom'
import { Pressable, Text, View } from 'react-native'
import type * as Y from 'yjs'
import { useResolveSuggestion } from '../hooks/use-resolve-suggestion'
import {
    anchoredOverlayReducer,
    decodeUiMessage,
    initialAnchoredOverlayState,
} from '../lib/anchored-overlay/anchored-overlay-state'
import { publishUiMessage, subscribeUiMessage } from '../lib/anchored-overlay/ui-message-bus'
import { resolveSlashMenuIcon } from '../lib/editor/slash-menu-icon-lookup'
import type { SlashMenuAnchor } from '../lib/stores/slash-menu-store'
import { useSlashMenuStore } from '../lib/stores/slash-menu-store'
import { SuggestionPopover } from './SuggestionPopover'

// Vertical gap between the caret and the popover so the menu doesn't
// crowd the line of text the user is typing on. Tuned by eye.
const POPOVER_GAP_PX = 4
// Estimated popover height used to flip above the caret when there
// isn't room below. A precise post-measure flip would feel snappier
// but adds a layout-then-paint flicker; the rough estimate is fine
// for v1 and matches how Tiptap's built-in tippy positioning behaves.
const POPOVER_HEIGHT_ESTIMATE_PX = 320
const POPOVER_WIDTH_PX = 260
// Suggestion popover is much shorter than the slash menu (two buttons
// or a small "pending" line). The flip threshold for the suggestion
// kind uses a smaller estimate so it doesn't flip above the caret
// unnecessarily.
const SUGGESTION_POPOVER_HEIGHT_ESTIMATE_PX = 80

// resolvePosition picks { top, left } in viewport coords given the
// anchor rect. Flips above the caret when the estimated popover
// height would extend past the viewport — without this, the menu
// disappears off-screen near the bottom of a long document.
function resolvePosition(anchor: SlashMenuAnchor): { top: number; left: number } {
    if (typeof window === 'undefined') {
        return { top: anchor.bottom + POPOVER_GAP_PX, left: anchor.left }
    }
    const viewportHeight = window.innerHeight
    const viewportWidth = window.innerWidth
    const wouldOverflowBottom =
        anchor.bottom + POPOVER_GAP_PX + POPOVER_HEIGHT_ESTIMATE_PX > viewportHeight
    const top = wouldOverflowBottom
        ? Math.max(8, anchor.top - POPOVER_GAP_PX - POPOVER_HEIGHT_ESTIMATE_PX)
        : anchor.bottom + POPOVER_GAP_PX
    const left = Math.min(
        Math.max(8, anchor.left),
        Math.max(8, viewportWidth - POPOVER_WIDTH_PX - 8)
    )
    return { top, left }
}

// Web equivalent of the AnchoredOverlayController's position math for
// rects that already live in viewport coords (which the in-process
// suggestion plugin posts — see lib/suggestions/popover.ts's
// rectFromClick). We don't have a WebView origin to add on web, so
// rect.top + rect.height IS the viewport y of the rect's bottom.
function resolveSuggestionPosition(rect: {
    top: number
    left: number
    width: number
    height: number
}): { top: number; left: number } {
    if (typeof window === 'undefined') {
        return { top: rect.top + rect.height + POPOVER_GAP_PX, left: rect.left }
    }
    const viewportHeight = window.innerHeight
    const viewportWidth = window.innerWidth
    const anchorBottom = rect.top + rect.height
    const wouldOverflowBottom =
        anchorBottom + POPOVER_GAP_PX + SUGGESTION_POPOVER_HEIGHT_ESTIMATE_PX > viewportHeight
    const top = wouldOverflowBottom
        ? Math.max(8, rect.top - POPOVER_GAP_PX - SUGGESTION_POPOVER_HEIGHT_ESTIMATE_PX)
        : anchorBottom + POPOVER_GAP_PX
    const left = Math.min(Math.max(8, rect.left), Math.max(8, viewportWidth - POPOVER_WIDTH_PX - 8))
    return { top, left }
}

// SuggestionPopoverContainer — web counterpart to the host wrapper in
// SlashMenu.tsx. Identical contract: bridges the registry's
// (payload, respond) callback shape with the resolve mutation + the
// role gate. The reason this lives next to the native wrapper rather
// than being shared is that the native controller is RN-Modal-based
// (its render path is Platform.OS guarded) and the web mount uses DOM
// portals — keeping the two near their respective overlay routers
// keeps the dependency direction obvious.
function SuggestionPopoverContainer({
    payload,
    respond,
    editor,
    yDoc,
    canResolve,
}: {
    payload: unknown
    respond: (action: 'select' | 'dismiss', payload?: unknown) => void
    editor: Editor | null
    yDoc: Y.Doc | null
    canResolve: boolean
}) {
    const suggestionId = (payload as { suggestionId?: string } | null)?.suggestionId ?? ''
    const { accept, reject, isPending } = useResolveSuggestion(suggestionId, {
        editor,
        yDoc,
    })

    return (
        <SuggestionPopover
            payload={payload}
            respond={respond}
            canResolve={canResolve}
            isPending={isPending}
            onAccept={async () => {
                await accept()
                respond('select', { resolution: 'accept', suggestionId })
            }}
            onReject={async () => {
                await reject()
                respond('select', { resolution: 'reject', suggestionId })
            }}
        />
    )
}

interface SlashMenuProps {
    webViewRef?: React.RefObject<unknown> | null
    editor?: Editor | null
    yDoc?: Y.Doc | null
    canResolve?: boolean
}

// SlashMenu renders both the floating popover for the `/`-trigger command
// palette (from the Zustand store) AND the suggestion popover surfaced
// by clicks on suggestedInsert / suggestedDelete decorations (via the
// in-process ui-message-bus). Web-only: portals to the document body
// so both overlays float over the editor surface without being clipped
// by the editor's scroll container.
//
// The native variant takes a `webViewRef` prop the controller needs
// for .measure() / .postMessage(); the web mount accepts the same
// prop signature and ignores it so the screen-level mount is
// platform-agnostic. editor / yDoc / canResolve drive the suggestion
// popover's resolve mutations + the role gate.
export function SlashMenu({ editor = null, yDoc = null, canResolve = false }: SlashMenuProps = {}) {
    return (
        <>
            <SlashMenuPalette />
            <SuggestionOverlay editor={editor} yDoc={yDoc} canResolve={canResolve} />
        </>
    )
}

// SlashMenuPalette renders the `/`-trigger command palette. Listens to
// the Zustand store driven by the SlashMenu Tiptap extension (see
// lib/editor/slash-menu.ts and slash-menu-render-store.ts).
function SlashMenuPalette() {
    const isOpen = useSlashMenuStore(s => s.isOpen)
    const items = useSlashMenuStore(s => s.items)
    const anchor = useSlashMenuStore(s => s.anchor)
    const selectedIndex = useSlashMenuStore(s => s.selectedIndex)
    const onSelect = useSlashMenuStore(s => s.onSelect)
    const close = useSlashMenuStore(s => s.close)

    // Click-outside dismiss. The suggestion plugin already closes on
    // text changes that invalidate the trigger, but a stray click on
    // the page (toolbar, sidebar) doesn't generate a transaction and
    // would leave the popover stranded.
    useEffect(() => {
        if (!isOpen || typeof document === 'undefined') return
        function onPointerDown(event: MouseEvent) {
            const target = event.target
            if (!(target instanceof Element)) return
            if (target.closest('[data-tinycld-slash-menu]')) return
            close()
        }
        document.addEventListener('mousedown', onPointerDown, true)
        return () => document.removeEventListener('mousedown', onPointerDown, true)
    }, [isOpen, close])

    const position = useMemo(() => (anchor ? resolvePosition(anchor) : null), [anchor])

    if (!isOpen || !position || typeof document === 'undefined') return null
    if (items.length === 0) return null

    // Listbox+option pairing throughout — screen readers expect a
    // listbox container to contain only `role="option"` children, with
    // the active descendant announced via aria-activedescendant. The
    // `data-tinycld-slash-menu` attribute is the hook the click-outside
    // listener uses to scope dismissal.
    const containerDomProps = {
        'data-tinycld-slash-menu': 'true',
        role: 'listbox',
        'aria-label': 'Slash menu',
    } as object

    return createPortal(
        <View
            accessibilityRole="menu"
            accessibilityLabel="Slash menu"
            {...containerDomProps}
            style={
                {
                    position: 'fixed',
                    top: position.top,
                    left: position.left,
                    width: POPOVER_WIDTH_PX,
                    maxHeight: POPOVER_HEIGHT_ESTIMATE_PX,
                    zIndex: 1000,
                } as object
            }
            className="rounded-lg border border-border bg-background py-1 overflow-hidden shadow-lg"
        >
            <View style={{ maxHeight: POPOVER_HEIGHT_ESTIMATE_PX, overflowY: 'auto' } as object}>
                {items.map((item, index) => (
                    <SlashMenuRow
                        key={item.id}
                        label={item.label}
                        Icon={resolveSlashMenuIcon(item.iconName)}
                        isSelected={index === selectedIndex}
                        onPress={() => onSelect?.(item)}
                    />
                ))}
            </View>
        </View>,
        document.body
    )
}

// SuggestionOverlay — subscribes to the in-process ui-message-bus for
// 'show-popover' messages of kind='suggestion' and renders the
// SuggestionPopover when one arrives. The bus is the web counterpart
// to the native AnchoredOverlayController's bus subscription (see
// lib/anchored-overlay/anchored-overlay-controller.tsx); we use the
// same reducer + decode helpers to keep the protocol semantics in
// lockstep across platforms.
//
// We don't reuse the native controller directly because:
//   - it returns null on Platform.OS === 'web' (intentional — native
//     RN Modal isn't the right primitive for browser overlays)
//   - it uses .measure() on a WebView ref to translate viewport →
//     screen coords; on web, viewport === screen and there's no
//     WebView ref
//   - it renders a transparent <Modal>; on web we portal to
//     document.body directly
function SuggestionOverlay({
    editor,
    yDoc,
    canResolve,
}: {
    editor: Editor | null
    yDoc: Y.Doc | null
    canResolve: boolean
}) {
    const [state, dispatch] = useReducer(anchoredOverlayReducer, initialAnchoredOverlayState)

    // Subscribe to the bus once on mount. The native controller does
    // the same; the only difference is we filter to kind='suggestion'
    // at the render boundary (the slash menu kind is handled via the
    // Zustand store path, not the bus).
    useEffect(() => {
        const unsubscribe = subscribeUiMessage(message => {
            const action = decodeUiMessage(message)
            if (action) dispatch(action)
        })
        return unsubscribe
    }, [])

    const isOpenSuggestion = state.open?.kind === 'suggestion'
    const openRequestId = state.open?.requestId

    // Click-outside dismiss. Matches the SlashMenuPalette pattern above
    // (a pointerdown listener with capture=true so the popover closes
    // before the click also reaches the editor and could re-fire a new
    // popover trigger). Scoped via the data attribute on the popover
    // wrapper so clicks INSIDE the popover (Accept/Reject buttons)
    // don't dismiss.
    useEffect(() => {
        if (!isOpenSuggestion || typeof document === 'undefined') return
        if (!openRequestId) return
        const onPointerDown = (event: MouseEvent) => {
            const target = event.target
            if (!(target instanceof Element)) return
            if (target.closest('[data-tinycld-suggestion-popover]')) return
            publishUiMessage({
                namespace: 'ui',
                type: 'popover-result',
                requestId: openRequestId,
                payload: { action: 'dismiss' as const },
            })
            dispatch({ type: 'dismiss-external' })
        }
        document.addEventListener('mousedown', onPointerDown, true)
        return () => document.removeEventListener('mousedown', onPointerDown, true)
    }, [isOpenSuggestion, openRequestId])

    if (!state.open) return null
    if (state.open.kind !== 'suggestion') return null
    if (typeof document === 'undefined') return null

    const open = state.open
    const position = resolveSuggestionPosition(open.rect)

    const respond = (action: 'select' | 'dismiss', payload?: unknown) => {
        publishUiMessage({
            namespace: 'ui',
            type: 'popover-result',
            requestId: open.requestId,
            payload: { action, payload: payload ?? undefined },
        })
        dispatch({ type: 'respond', requestId: open.requestId })
    }

    // The popover is a single positioned View; no backdrop element.
    // Click-outside is wired by the pointerdown listener above so we
    // don't introduce an interactive non-button element (which biome
    // a11y rules — correctly — flag, and which would also intercept
    // clicks the slash menu's overlay needs).
    return createPortal(
        <View
            data-tinycld-suggestion-popover="true"
            style={
                {
                    position: 'fixed',
                    top: position.top,
                    left: position.left,
                    width: POPOVER_WIDTH_PX,
                    zIndex: 1000,
                } as object
            }
        >
            <SuggestionPopoverContainer
                payload={open.payload}
                respond={respond}
                editor={editor}
                yDoc={yDoc}
                canResolve={canResolve}
            />
        </View>,
        document.body
    )
}

interface SlashMenuRowProps {
    label: string
    Icon: LucideIcon | null
    isSelected: boolean
    onPress: () => void
}

function SlashMenuRow({ label, Icon, isSelected, onPress }: SlashMenuRowProps) {
    const foregroundColor = useThemeColor('foreground')
    // role="option" matches the parent listbox; aria-selected exposes
    // the current keyboard-highlight to screen readers without needing
    // a separate live region for the active descendant.
    const optionDomProps = {
        role: 'option',
        'aria-selected': isSelected,
    } as const
    return (
        <Pressable
            onPress={onPress}
            accessibilityLabel={label}
            {...optionDomProps}
            className={`flex-row items-center gap-2 px-3 py-2 ${
                isSelected ? 'bg-surface-secondary' : 'bg-transparent'
            }`}
        >
            {Icon ? <Icon size={16} color={foregroundColor} /> : null}
            <Text className="text-sm text-foreground">{label}</Text>
        </Pressable>
    )
}
