import {
    SidebarActionButton,
    SidebarHeading,
    SidebarItem,
    SidebarNav,
} from '@tinycld/core/components/sidebar-primitives'
import { useOrgHref } from '@tinycld/core/lib/org-routes'
import { router, usePathname } from 'expo-router'
import { LayoutTemplate } from 'lucide-react-native'
import { useState } from 'react'
import { TemplatePicker } from './components/TemplatePicker'
import {
    useCreateBlankTextDocument,
    useCreateTextDocumentFromTemplate,
    useTextDocuments,
} from './hooks/use-text-documents'
import type { TemplateId } from './lib/templates/index'

interface TextSidebarProps {
    isCollapsed: boolean
}

export default function TextSidebar(_props: TextSidebarProps) {
    const orgHref = useOrgHref()
    const pathname = usePathname()
    const { data: items = [] } = useTextDocuments()
    const blank = useCreateBlankTextDocument()
    const template = useCreateTextDocumentFromTemplate()
    // Local UI: the sidebar opens its own picker independently of the
    // index screen's picker. Using a local useState here keeps the two
    // surfaces decoupled — neither needs the other's picker state.
    const [isPickerOpen, setPickerOpen] = useState(false)

    const goToDoc = (itemId: string) => router.push(orgHref('text/[id]', { id: itemId }))
    const handleCreate = () => blank.create(goToDoc)
    const handleOpenPicker = () => setPickerOpen(true)
    const handleClosePicker = () => setPickerOpen(false)
    const handlePick = (id: TemplateId) => {
        setPickerOpen(false)
        if (id === 'blank') {
            blank.create(goToDoc)
            return
        }
        template.create(id, goToDoc)
    }

    const recentItems = items.slice(0, 10)

    return (
        <>
            <SidebarNav>
                <SidebarActionButton label="+ New document" onPress={handleCreate} />
                <SidebarActionButton
                    label="From template…"
                    icon={LayoutTemplate}
                    onPress={handleOpenPicker}
                />

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
            <TemplatePicker
                isOpen={isPickerOpen}
                onClose={handleClosePicker}
                onPick={handlePick}
                isPending={template.isPending}
            />
        </>
    )
}
