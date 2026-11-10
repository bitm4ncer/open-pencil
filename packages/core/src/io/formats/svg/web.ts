import { webSVGIndex } from '@open-pencil/dom-css/scene-graph'
import type { SceneGraph, SceneNode } from '@open-pencil/scene-graph'
import { rescaleNodeTree } from '@open-pencil/scene-graph/scaling'

import type { CapturedSVG } from './capture'
import { createSVGNodesFromImport, prepareSVGImport } from './import'

/** `rescaleNodeTree` refuses a smaller scale, so a vector too tiny to scale stays raster. */
const MIN_VECTOR_SCALE = 0.01

/**
 * A large illustration built from gradients, patterns, or embedded images loses more than it gains
 * as vectors: the importer draws unsupported paints in flat black. Its capture already rasterized
 * it, so that keeps the picture the page showed. Icons and logos stay editable.
 */
const MAX_COMPLEX_VECTOR_EDGE = 320
const COMPLEX_SVG_MARKUP = /<(?:linearGradient|radialGradient|pattern|filter|foreignObject|image)\b/i

function keepsRasterFallback(captured: CapturedSVG): boolean {
  return (
    Math.max(captured.width, captured.height) > MAX_COMPLEX_VECTOR_EDGE &&
    COMPLEX_SVG_MARKUP.test(captured.svg)
  )
}

/** What replacing captured SVGs did: vectors built, and rasters left in place. */
export interface WebSVGReplacement {
  replaced: number
  kept: number
}

/** Fits a freshly built vector into the captured box, centered with its aspect ratio kept. */
function placeCapturedVector(
  graph: SceneGraph,
  root: SceneNode,
  parentId: string,
  captured: CapturedSVG,
  intrinsicWidth: number,
  intrinsicHeight: number
): boolean {
  const scale =
    intrinsicWidth > 0 && intrinsicHeight > 0
      ? Math.min(captured.width / intrinsicWidth, captured.height / intrinsicHeight)
      : 0
  if (!Number.isFinite(scale) || scale < MIN_VECTOR_SCALE) return false

  try {
    rescaleNodeTree(graph, root.id, scale)
    const origin = graph.getAbsolutePosition(parentId)
    graph.updateNode(root.id, {
      x: captured.x - origin.x + (captured.width - intrinsicWidth * scale) / 2,
      y: captured.y - origin.y + (captured.height - intrinsicHeight * scale) / 2,
      // The importer's frame starts white for a standalone file; a page icon must stay transparent.
      ...(root.type === 'FRAME' ? { fills: [] } : {})
    })
    return true
  } catch (error) {
    console.warn('Could not place the captured SVG vector:', error)
    return false
  }
}

/** Replaces one marked raster layer, or leaves it when its source cannot become vectors. */
function replaceMarkedLayer(graph: SceneGraph, node: SceneNode, captured: CapturedSVG): boolean {
  if (keepsRasterFallback(captured)) return false
  const parentId = node.parentId
  const parent = parentId ? graph.getNode(parentId) : undefined
  if (!parentId || !parent) return false

  const data = prepareSVGImport(captured.svg)
  if (!data) return false

  const childIndex = parent.childIds.indexOf(node.id)
  let root: SceneNode | null
  try {
    root = createSVGNodesFromImport(graph, parentId, data, {
      name: captured.name ?? data.name ?? 'SVG'
    })
  } catch (error) {
    console.warn('Could not import the captured SVG vector:', error)
    return false
  }
  if (!root) return false

  const intrinsicWidth = data.sized ? data.width : root.width
  const intrinsicHeight = data.sized ? data.height : root.height
  if (!placeCapturedVector(graph, root, parentId, captured, intrinsicWidth, intrinsicHeight)) {
    graph.deleteNode(root.id)
    return false
  }

  const insertAt = childIndex !== -1 ? childIndex : parent.childIds.length
  graph.deleteNode(node.id)
  graph.insertChildAt(root.id, parentId, insertAt)
  return true
}

/**
 * Replaces the raster layers a web capture marked with their SVG vectors, at the box the page
 * drew them in. A source that does not parse, or a layer that no longer exists, keeps its raster
 * fallback, so the imported HTML stays usable either way.
 */
export function replaceCapturedSVGImages(
  graph: SceneGraph,
  svgs: readonly CapturedSVG[]
): WebSVGReplacement {
  let replaced = 0
  let kept = 0
  for (const { node } of graph.flattenTree()) {
    const index = webSVGIndex(node)
    if (index === null) continue
    const captured = index < svgs.length ? svgs[index] : undefined
    if (!captured || captured.svg.trim().length === 0) continue
    if (replaceMarkedLayer(graph, node, captured)) replaced++
    else kept++
  }
  return { replaced, kept }
}
