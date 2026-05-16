import {
    SidebarActionButton,
    SidebarHeading,
    SidebarItem,
    SidebarNav,
} from '@tinycld/core/components/sidebar-primitives'
import { useOrgHref } from '@tinycld/core/lib/org-routes'
import { router, usePathname } from 'expo-router'
import { useCreateBlankTextDocument, useTextDocuments } from './hooks/use-text-documents'

interface TextSidebarProps {
    isCollapsed: boolean
}

export default function TextSidebar(_props: TextSidebarProps) {
    const orgHref = useOrgHref()
    const pathname = usePathname()
    const { data: items = [] } = useTextDocuments()
    const { create } = useCreateBlankTextDocument()

    const handleCreate = () => {
        create(itemId => router.push(orgHref('text/[id]', { id: itemId })))
    }

    const recentItems = items.slice(0, 10)

    return (
        <SidebarNav>
            <SidebarActionButton label="+ New document" onPress={handleCreate} />

            <SidebarHeading>Recent</SidebarHeading>
            {recentItems.map(item => (
                <SidebarItem
                    key={item.id}
                    label={item.name}
                    isActive={pathname.endsWith(`/text/${item.id}`)}
                    closesDrawer
                    onPress={() => router.push(orgHref('text/[id]', { id: item.id }))}
                />
            ))}
        </SidebarNav>
    )
}
