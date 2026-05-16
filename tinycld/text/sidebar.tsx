import { and, eq } from '@tanstack/db'
import {
    SidebarActionButton,
    SidebarHeading,
    SidebarItem,
    SidebarNav,
} from '@tinycld/core/components/sidebar-primitives'
import { captureException } from '@tinycld/core/lib/errors'
import { useOrgHref } from '@tinycld/core/lib/org-routes'
import { useStore } from '@tinycld/core/lib/pocketbase'
import { useOrgLiveQuery } from '@tinycld/core/lib/use-org-live-query'
import { useCreateDriveItem } from '@tinycld/drive/lib/upload-to-drive'
import { router, usePathname } from 'expo-router'
import { createBlankTextDocument } from './lib/create-blank-text-document'
import { DOCX_MIME_TYPE } from './lib/mime'

interface TextSidebarProps {
    isCollapsed: boolean
}

export default function TextSidebar(_props: TextSidebarProps) {
    const orgHref = useOrgHref()
    const pathname = usePathname()
    const [driveItemsCollection] = useStore('drive_items')
    const create = useCreateDriveItem()

    const { data: items = [] } = useOrgLiveQuery((query, { orgId }) =>
        query
            .from({ item: driveItemsCollection })
            .where(({ item }) =>
                and(
                    eq(item.org, orgId),
                    eq(item.mime_type, DOCX_MIME_TYPE),
                    eq(item.is_folder, false)
                )
            )
            .orderBy(({ item }) => item.updated, 'desc')
    )

    const handleCreate = () => {
        createBlankTextDocument({
            mutate: create.mutate,
            onCreated: itemId => router.push(orgHref('text/[id]', { id: itemId })),
            captureException,
        })
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
