import { openHelp, openHelpPackage } from '@tinycld/core/lib/help/open-help'
import { useHelpSearchStore } from '@tinycld/core/lib/help/search-store'
import { useReportIssue } from '@tinycld/core/lib/help/use-report-issue'
import { Menu, MenuBarMenu } from '@tinycld/core/ui/menubar'
import { Platform } from 'react-native'
import type { MenuBarProps } from './MenuBar'

// The search palette's shortcut is bound on web only.
const SEARCH_SHORTCUT = Platform.OS === 'web' ? '⌘/' : undefined

// The Help menu is glanceable on purpose: one global search entry,
// one direct link to the highest-traffic reference (keyboard
// shortcuts), and a breadcrumb to the full topic index. Per-topic
// entries live in the search palette now — listing them inline made
// the menu a wall of text.
export function HelpMenu(_props: MenuBarProps) {
    const reportIssue = useReportIssue('text')

    return (
        <MenuBarMenu menuId="help" label="Help">
            <Menu.Item
                label="Search help…"
                shortcut={SEARCH_SHORTCUT}
                onSelect={() => useHelpSearchStore.getState().open()}
            />
            <Menu.Item
                label="Keyboard shortcuts"
                onSelect={() => openHelp('text:keyboard-shortcuts')}
            />
            <Menu.Separator />
            <Menu.Item label="Browse text help" onSelect={() => openHelpPackage('text')} />
            {reportIssue && <Menu.Item label="Report an issue" onSelect={reportIssue} />}
        </MenuBarMenu>
    )
}
