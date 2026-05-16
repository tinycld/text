interface HandleImageInsertDeps {
    pickImageAsDataUri: () => Promise<string | null>
    captureException: (tag: string, err: unknown) => void
}

// Orchestrates picker → onInsert → captureException. Lives in its own
// non-component module so vitest can import it under node-env without
// pulling react-native through the transform graph.
export async function handleImageInsert(
    onInsert: (dataUri: string) => void,
    deps: HandleImageInsertDeps
): Promise<void> {
    try {
        const dataUri = await deps.pickImageAsDataUri()
        if (dataUri == null) return
        onInsert(dataUri)
    } catch (err) {
        deps.captureException('text.imageInsert', err)
    }
}
