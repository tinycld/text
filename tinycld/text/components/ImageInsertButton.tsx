import type { ComponentType } from 'react'
import { Platform, Pressable } from 'react-native'

interface ImageInsertButtonProps {
    icon: ComponentType<{ size: number; color: string }>
    iconColor: string
    disabled?: boolean
    onInsert: (dataUri: string) => void
}

// v1 uses data: URIs; v2 will upload to drive and use the resulting URL.
//
// Opens a file picker, reads the picked image as a base64 data: URI,
// and hands it back to the toolbar for insertion via Tiptap's setImage.
// This intentionally avoids any drive upload because (a) we haven't
// surfaced a generic "upload file" hook the text package can call yet,
// and (b) data URIs round-trip through ProseMirror → docx fine for
// small images. v2 should swap to a real upload + URL once the API
// surface stabilises.
export function ImageInsertButton({
    icon: Icon,
    iconColor,
    disabled = false,
    onInsert,
}: ImageInsertButtonProps) {
    const handlePress = async () => {
        const dataUri = await pickImageAsDataUri()
        if (dataUri == null) return
        onInsert(dataUri)
    }

    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel="Insert image"
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={handlePress}
            className="rounded-md p-1.5"
            style={disabled ? { opacity: 0.4 } : undefined}
        >
            <Icon size={16} color={iconColor} />
        </Pressable>
    )
}

async function pickImageAsDataUri(): Promise<string | null> {
    if (Platform.OS === 'web') {
        return pickImageWeb()
    }
    return pickImageNative()
}

function pickImageWeb(): Promise<string | null> {
    if (typeof document === 'undefined') return Promise.resolve(null)
    return new Promise(resolve => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = 'image/png,image/jpeg,image/gif,image/webp'
        let settled = false
        const settle = (value: string | null) => {
            if (settled) return
            settled = true
            resolve(value)
        }
        input.onchange = () => {
            const file = input.files?.[0]
            if (file == null) return settle(null)
            const reader = new FileReader()
            reader.onload = () => {
                const result = reader.result
                if (typeof result === 'string') {
                    settle(result)
                } else {
                    settle(null)
                }
            }
            reader.onerror = () => settle(null)
            reader.readAsDataURL(file)
        }
        input.addEventListener('cancel', () => settle(null))
        input.click()
    })
}

async function pickImageNative(): Promise<string | null> {
    const picker = await import('expo-document-picker')
    const fs = await import('expo-file-system')
    const result = await picker.getDocumentAsync({
        type: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
        copyToCacheDirectory: true,
    })
    if (result.canceled) return null
    const asset = result.assets?.[0]
    if (asset == null) return null
    const fileSystem = fs as unknown as {
        readAsStringAsync: (uri: string, opts: { encoding: string }) => Promise<string>
    }
    const base64 = await fileSystem.readAsStringAsync(asset.uri, { encoding: 'base64' })
    const mime = asset.mimeType ?? 'image/png'
    return `data:${mime};base64,${base64}`
}
