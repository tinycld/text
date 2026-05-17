import {
    Code2,
    Heading1,
    Heading2,
    Heading3,
    Image as ImageIcon,
    List,
    ListOrdered,
    type LucideIcon,
    Minus,
    Quote,
    Table as TableIcon,
} from 'lucide-react-native'

// Lucide identifier → component map for the slash menu's serialized
// wire format. The bridge render strategy can't post a LucideIcon
// reference across the WebView's JSON message bus, so each command
// carries a string `iconName` (e.g. 'Heading1', 'Image') the host
// resolves back to the actual icon component here.
//
// Keep in sync with the iconName field set in
// slash-menu-commands.ts::SLASH_MENU_COMMANDS — the unit test
// slash-menu-icon-lookup.test.ts asserts the iconName for every
// command resolves to a component in this map.
export const SLASH_MENU_ICONS: Record<string, LucideIcon> = {
    Heading1,
    Heading2,
    Heading3,
    List,
    ListOrdered,
    Quote,
    Code2,
    Table: TableIcon,
    Image: ImageIcon,
    Minus,
}

// Look up an icon by the wire identifier. Returns the component if
// known, or null if the host shipped a command whose iconName isn't
// in the lookup (e.g. a third-party slash entry from a future
// extension point). The popover renders nothing in the icon slot for
// unknown entries — the label still appears.
export function resolveSlashMenuIcon(iconName: string): LucideIcon | null {
    return SLASH_MENU_ICONS[iconName] ?? null
}
