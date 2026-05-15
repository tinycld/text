import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { useLocalSearchParams } from 'expo-router'
import { Text, View } from 'react-native'

// Dynamic detail route. Wired automatically by core's generator to
// /a/<orgSlug>/text/<id>.
//
// To navigate back to the index or to another org-scoped screen, use
// `useOrgHref()` from `@tinycld/core/lib/org-routes`. See
// https://tinycld.org/docs/tasks/routing

export default function TextDetail() {
    const { id } = useLocalSearchParams<{ id: string }>()
    const fg = useThemeColor('foreground')
    const muted = useThemeColor('muted-foreground')

    return (
        <View className="p-6 gap-3">
            <Text style={{ color: fg, fontSize: 22, fontWeight: '600' }}>Text detail</Text>
            <Text style={{ color: muted, fontSize: 14 }}>Showing item {id}</Text>
        </View>
    )
}
