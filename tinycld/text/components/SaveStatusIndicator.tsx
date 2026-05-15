import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { AlertCircle, Check } from 'lucide-react-native'
import { Text, View } from 'react-native'

interface SaveStatusIndicatorProps {
    status: 'ok' | 'failed'
}

// Pinned status pill showing whether the server is successfully
// persisting the doc back to the .docx blob. Driven by the
// MsgServerSlot frame the text broker emits whenever its serialise +
// upload pipeline completes (successfully or with an error). Defaults
// to 'ok' — the server only emits when there's something to report,
// so absence of a slot frame implicitly means "things are fine."
export function SaveStatusIndicator({ status }: SaveStatusIndicatorProps) {
    const successColor = useThemeColor('success')
    const dangerColor = useThemeColor('danger')

    if (status === 'ok') {
        return (
            <View className="flex-row items-center gap-1.5 px-2 py-1 rounded-full">
                <Check size={12} color={successColor} />
                <Text className="text-xs text-muted-foreground">Saved</Text>
            </View>
        )
    }

    return (
        <View className="flex-row items-center gap-1.5 px-2 py-1 rounded-full bg-danger-soft">
            <AlertCircle size={12} color={dangerColor} />
            <Text className="text-xs text-danger">Save failed</Text>
        </View>
    )
}
