import { openHelp } from '@tinycld/core/lib/help/open-help'
import { useOrgHref } from '@tinycld/core/lib/org-routes'
import { Menu, MenuBarMenu, MenuShortcut, Separator } from '@tinycld/core/ui/menubar'
import { router } from 'expo-router'
import { Platform } from 'react-native'
import type { MenuBarProps } from './MenuBar'

// Topic IDs match the filenames under text/help/ (without `.md`).
// Listing the most-used topics inline lets users jump straight to
// the relevant page without clicking through the per-package index;
// "Browse all topics" still navigates to the hub for full breadth.
const INLINE_TOPICS: ReadonlyArray<{ topicId: string; label: string }> = [
    { topicId: 'templates', label: 'Document templates' },
    { topicId: 'slash-menu', label: 'Slash menu' },
    { topicId: 'alignment-indent', label: 'Alignment & indent' },
    { topicId: 'font', label: 'Fonts' },
    { topicId: 'code-blocks', label: 'Code formatting' },
    { topicId: 'images', label: 'Images' },
    { topicId: 'table-shading', label: 'Table cell shading' },
]

export function HelpMenu(_props: MenuBarProps) {
    const orgHref = useOrgHref()
    return (
        <MenuBarMenu menuId="help" label="Help">
            {INLINE_TOPICS.map(t => (
                <Menu.Item key={t.topicId} onPress={() => openHelp(`text:${t.topicId}`)}>
                    <Menu.ItemTitle>{t.label}</Menu.ItemTitle>
                </Menu.Item>
            ))}
            <Separator />
            <Menu.Item onPress={() => router.push(orgHref('help/text'))}>
                <Menu.ItemTitle>Browse all topics…</Menu.ItemTitle>
            </Menu.Item>
            {Platform.OS === 'web' && (
                <Menu.Item onPress={() => openHelp('text:keyboard-shortcuts')}>
                    <Menu.ItemTitle>Keyboard shortcuts</Menu.ItemTitle>
                    <MenuShortcut keys="⌘/" />
                </Menu.Item>
            )}
        </MenuBarMenu>
    )
}
