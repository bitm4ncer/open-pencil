import { isValid, toUint8Array } from 'js-base64'

import { BLACK } from '@open-pencil/scene-graph/constants'
import { computeImageHash } from '@open-pencil/scene-graph/images'

import type { EditorStore } from '@/app/editor/session/create'

export interface WebImportReference {
  src: string
  width: number
  height: number
}

const MAX_REFERENCE_EDGE = 4096

function imageBytes(src: string): Uint8Array | null {
  const comma = src.indexOf(',')
  if (comma === -1) return null
  const data = src.slice(comma + 1)
  if (!isValid(data)) return null
  return toUint8Array(data)
}

/** Keeps a full-page reference inside the renderer's texture limit, cropped to the viewport. */
async function limitReference(bytes: Uint8Array, cropWidth?: number): Promise<Uint8Array> {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const bitmap = await createImageBitmap(new Blob([copy]))
  try {
    const sourceWidth = cropWidth ? Math.min(bitmap.width, cropWidth) : bitmap.width
    const scale = Math.min(1, MAX_REFERENCE_EDGE / Math.max(sourceWidth, bitmap.height))
    if (scale === 1 && sourceWidth === bitmap.width) return bytes
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(sourceWidth * scale)),
      Math.max(1, Math.round(bitmap.height * scale))
    )
    const context = canvas.getContext('2d')
    if (!context) return bytes
    context.drawImage(
      bitmap,
      0,
      0,
      sourceWidth,
      bitmap.height,
      0,
      0,
      canvas.width,
      canvas.height
    )
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.86 })
    return new Uint8Array(await blob.arrayBuffer())
  } finally {
    bitmap.close()
  }
}

/**
 * Places the captured page beside the imported layers, so the source and the editable result
 * can be compared without leaving the document.
 */
export async function placeWebImportReference(
  store: EditorStore,
  host: string,
  reference: WebImportReference,
  options: { x?: number; y?: number; name?: string; cropWidth?: number } = {}
): Promise<void> {
  const raw = imageBytes(reference.src)
  const page = store.graph.getNode(store.state.currentPageId)
  if (!raw || !page) return
  const bytes = await limitReference(raw, options.cropWidth).catch(() => raw)
  const width = options.cropWidth ? Math.min(reference.width, options.cropWidth) : reference.width

  let maxX = 0
  for (const childId of page.childIds) {
    const bounds = store.graph.getAbsoluteBounds(childId)
    maxX = Math.max(maxX, bounds.x + bounds.width)
  }

  const hash = computeImageHash(bytes)
  store.graph.images.set(hash, bytes)
  store.graph.createNode('RECTANGLE', page.id, {
    name: options.name ?? `Original — ${host}`,
    x: options.x ?? Math.max(maxX, width) + 120,
    y: options.y ?? 0,
    width,
    height: reference.height,
    fills: [
      {
        type: 'IMAGE',
        imageHash: hash,
        imageScaleMode: 'FILL',
        color: BLACK,
        opacity: 1,
        visible: true
      }
    ]
  })
  store.requestRender()
}
