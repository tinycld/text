import { and, eq } from '@tanstack/db'
import {
    SidebarActionButton,
    SidebarHeading,
    SidebarItem,
    SidebarNav,
} from '@tinycld/core/components/sidebar-primitives'
import { useOrgHref } from '@tinycld/core/lib/org-routes'
import { useStore } from '@tinycld/core/lib/pocketbase'
import { useOrgLiveQuery } from '@tinycld/core/lib/use-org-live-query'
import { useCreateDriveItem } from '@tinycld/drive/lib/upload-to-drive'
import { router, usePathname } from 'expo-router'
import { useCallback } from 'react'
import { DOCX_MIME_TYPE } from './lib/mime'

interface TextSidebarProps {
    isCollapsed: boolean
}

function blankDocxBlob(): Blob {
    return new Blob([], { type: DOCX_MIME_TYPE })
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

    const handleCreate = useCallback(async () => {
        const result = await create.mutateAsync({
            body: blankDocxBlob(),
            name: 'Untitled.docx',
            mimeType: DOCX_MIME_TYPE,
        })
        router.push(orgHref('text/[id]', { id: result.itemId }))
    }, [create, orgHref])

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
