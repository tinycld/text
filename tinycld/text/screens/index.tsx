import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { ScrollView, Text, View } from 'react-native'

// Org-scoped index route for Text, served at /a/<orgSlug>/text.
// Replace this placeholder with your list view (cards, table, whatever you
// need) and wire it to your pbtsdb collections using `useOrgLiveQuery`.
//
// For navigation, use `useOrgHref()` from `@tinycld/core/lib/org-routes` —
// never literal paths like `router.push('/text/new')`, which drop
// the org segment. See https://tinycld.org/docs/tasks/routing
//
//   const orgHref = useOrgHref()
//   router.push(orgHref('text/new'))
//   router.push(orgHref('text/[id]', { id: itemId }))

export default function TextIndex() {
    const fg = useThemeColor('foreground')
    const muted = useThemeColor('muted-foreground')

    return (
        <ScrollView className="flex-1 bg-background">
            <View className="p-6 gap-3">
                <Text style={{ color: fg, fontSize: 22, fontWeight: '600' }}>Text</Text>
                <Text style={{ color: muted, fontSize: 14 }}>Placeholder landing screen for text.</Text>
            </View>
        </ScrollView>
    )
}
