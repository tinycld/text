import type { ReactNode } from 'react'
import './lib/open-in-text-action'
import './lib/open-in-text-drive-action'

interface TextProviderProps {
    children: ReactNode
}

export default function TextProvider({ children }: TextProviderProps) {
    return <>{children}</>
}
