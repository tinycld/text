import { VersionHistoryScreen } from '@tinycld/drive/components/version-history/VersionHistoryScreen'
import { useLocalSearchParams } from 'expo-router'

// Version history opened from the editor: Drive's screen under Text's route,
// so the user stays in Text instead of switching to Drive.
export default function TextVersionHistoryRoute() {
    const { id } = useLocalSearchParams<{ id: string }>()
    return <VersionHistoryScreen itemId={id} />
}
