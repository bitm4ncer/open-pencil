import type { SceneGraph } from '@open-pencil/scene-graph'
import { parseColor } from '@open-pencil/scene-graph/color'
import type { Color } from '@open-pencil/scene-graph/primitives'

import { setPageBackgrounds } from '#core/figma-api/page-backgrounds'

/** A page's solid background as the browser computed it, or null when it is transparent. */
export function capturedPageColor(css: string | undefined): Color | null {
  if (!css) return null
  try {
    const color = parseColor(css)
    return color.a > 0 ? color : null
  } catch {
    return null
  }
}

/**
 * Gives an imported page the background its page showed. The body wrapper does not survive HTML
 * import, so without this the page falls back to the editor's default colour.
 */
export function applyCapturedPageBackground(
  graph: SceneGraph,
  css: string | undefined
): Color | null {
  const color = capturedPageColor(css)
  if (!color) return null
  const page = graph.getPages()[0]
  if (page.type !== 'CANVAS') return null
  setPageBackgrounds(graph, page, [
    { type: 'SOLID', color, opacity: 1, visible: true, blendMode: 'NORMAL' }
  ])
  return color
}
