import { useEffect } from 'react'

/**
 * Sets document.title for as long as the calling screen is mounted, then puts
 * the previous value back. Lives outside the component files so those files
 * only export components (react/only-export-components).
 */
export function useDocumentTitle(title) {
  useEffect(() => {
    const previous = document.title
    document.title = title
    return () => {
      document.title = previous
    }
  }, [title])
}