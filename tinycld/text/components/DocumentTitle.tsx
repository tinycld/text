import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { Controller, useForm, zodResolver } from '@tinycld/core/ui/form'
import { useRef, useState } from 'react'
import {
    Pressable,
    Text,
    TextInput,
    type TextInputInstance,
    type TextInputKeyPressEvent,
    View,
} from 'react-native'
import { useRenameDocument } from '../hooks/use-rename-document'
import {
    DOCUMENT_NAME_MAX_LENGTH,
    documentNameSchema,
    isUnchangedName,
    RENAME_FAILED_ERROR,
} from './document-title-edit'

interface DocumentTitleProps {
    documentId: string
    name: string
    isReadOnly: boolean
}

// Inline document-title editor. The static <Text> swaps to a focused
// <TextInput> when the user clicks the title (single click — double
// click adds nothing here and on iOS/Android there is no double-tap
// affordance for a title; single-click matches Drive's pattern).
//
// Edit-mode is genuine transient local UI state — no other component
// cares whether the title is in edit mode — so useState is the right
// primitive here. The draft itself lives in a form inside
// DocumentTitleEditor, which mounts fresh on every edit so it always
// starts from the current name. The rename mutation lives in
// useRenameDocument so the title can show its pending/error state
// without re-implementing the pbtsdb call.
export function DocumentTitle({ documentId, name, isReadOnly }: DocumentTitleProps) {
    const { rename, isPending, error, reset } = useRenameDocument(documentId)
    const [isEditing, setIsEditing] = useState(false)

    const enterEditMode = () => {
        if (isReadOnly || isPending) return
        reset()
        setIsEditing(true)
    }

    if (isEditing) {
        return (
            <DocumentTitleEditor name={name} onRename={rename} onDone={() => setIsEditing(false)} />
        )
    }

    return (
        <View className="flex-1">
            <Pressable
                accessibilityRole={isReadOnly ? 'text' : 'button'}
                accessibilityLabel={isReadOnly ? name : `Rename document, currently ${name}`}
                disabled={isReadOnly || isPending}
                onPress={enterEditMode}
            >
                <Text
                    className={`text-base font-semibold text-foreground ${isPending ? 'opacity-50' : ''}`}
                    numberOfLines={1}
                >
                    {name}
                </Text>
            </Pressable>
            {error != null ? (
                <Text className="text-xs text-danger mt-1">{RENAME_FAILED_ERROR}</Text>
            ) : null}
        </View>
    )
}

interface DocumentTitleEditorProps {
    name: string
    onRename: (newName: string) => void
    onDone: () => void
}

function useDocumentTitleEditor({ name, onRename, onDone }: DocumentTitleEditorProps) {
    const inputRef = useRef<TextInputInstance>(null)
    // One edit can fire several commits: blurOnSubmit blurs the input
    // right after Enter, and Escape unmounts the input, which makes
    // RN-web fire onBlur on it a tick later. The first one settles the
    // edit; the rest are no-ops, so a rename is never sent twice and
    // Escape never turns into a commit.
    const settledRef = useRef(false)
    const {
        control,
        handleSubmit,
        formState: { errors },
    } = useForm({
        resolver: zodResolver(documentNameSchema),
        defaultValues: { name },
    })

    const submit = handleSubmit(
        data => {
            if (!isUnchangedName(data.name, name)) onRename(data.name)
            onDone()
        },
        () => {
            // Hand focus back so the user can correct the value rather
            // than silently bouncing them to the static title with an
            // unexplained revert.
            settledRef.current = false
            inputRef.current?.focus()
        }
    )

    const commit = () => {
        if (settledRef.current) return
        settledRef.current = true
        submit()
    }

    const handleKeyPress = (e: TextInputKeyPressEvent) => {
        if (e.nativeEvent.key !== 'Escape') return
        settledRef.current = true
        onDone()
    }

    return { control, inputRef, commit, handleKeyPress, errorMessage: errors.name?.message }
}

function DocumentTitleEditor(props: DocumentTitleEditorProps) {
    const { control, inputRef, commit, handleKeyPress, errorMessage } =
        useDocumentTitleEditor(props)
    const fg = useThemeColor('foreground')

    return (
        <View className="flex-1">
            <Controller
                control={control}
                name="name"
                render={({ field }) => (
                    <TextInput
                        ref={inputRef}
                        value={field.value}
                        onChangeText={field.onChange}
                        autoFocus
                        selectTextOnFocus
                        maxLength={DOCUMENT_NAME_MAX_LENGTH}
                        onBlur={commit}
                        onSubmitEditing={commit}
                        onKeyPress={handleKeyPress}
                        returnKeyType="done"
                        blurOnSubmit
                        accessibilityLabel="Document name"
                        className="text-base font-semibold rounded-md border border-border bg-field-background px-2 py-1"
                        style={{ color: fg }}
                    />
                )}
            />
            <InlineError message={errorMessage} />
        </View>
    )
}

function InlineError({ message }: { message: string | undefined }) {
    if (message == null) return null
    return <Text className="text-xs text-danger mt-1">{message}</Text>
}
