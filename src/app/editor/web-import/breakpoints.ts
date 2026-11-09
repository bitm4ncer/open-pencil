/** A viewport the importer renders the page at, and the size it reports for it. */
export interface WebImportBreakpoint {
  id: WebImportBreakpointId
  label: string
  short: string
  width: number
  height: number
}

export type WebImportBreakpointId = '4k' | 'desktop' | 'full-hd' | 'laptop' | 'tablet' | 'mobile'

export const WEB_IMPORT_BREAKPOINTS = [
  { id: '4k', label: '4K', short: '4K', width: 2560, height: 1440 },
  { id: 'desktop', label: 'Desktop 1440', short: '1440', width: 1440, height: 900 },
  { id: 'full-hd', label: 'Desktop 1080p', short: '1080p', width: 1920, height: 1080 },
  { id: 'laptop', label: 'Laptop', short: 'Laptop', width: 1280, height: 800 },
  { id: 'tablet', label: 'Tablet', short: 'Tablet', width: 768, height: 1024 },
  { id: 'mobile', label: 'Mobile', short: 'Mobile', width: 390, height: 844 }
] as const satisfies readonly WebImportBreakpoint[]

export const DEFAULT_WEB_IMPORT_BREAKPOINT: WebImportBreakpointId = 'desktop'

export function webImportBreakpoint(id: WebImportBreakpointId): WebImportBreakpoint {
  return (
    WEB_IMPORT_BREAKPOINTS.find((breakpoint) => breakpoint.id === id) ?? WEB_IMPORT_BREAKPOINTS[1]
  )
}
