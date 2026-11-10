import * as v from 'valibot'

import { applyCapturedPageBackground, capturedPageColor } from '@open-pencil/core/io/formats/html/layers'
import { replaceCapturedSVGImages } from '@open-pencil/core/io/formats/svg'
import { cloneNodeProps } from '@open-pencil/scene-graph/copy'
import type { Color } from '@open-pencil/scene-graph/primitives'

import { getAutomationFiles } from '@/app/automation/bridge/server'
import { readDOMGraph } from '@/app/document/io/dom'
import type { EditorStore } from '@/app/editor/session'
import { placeWebImportReference } from '@/app/editor/web-import/reference'
import { capturedSVGSchema } from '@/app/editor/web-import/schema'
import { createDocumentTab, openFileInNewTab } from '@/app/tabs'

export interface WebImportOptions {
  selector?: string
  wait?: number
  scroll?: boolean
  reference?: boolean
  viewport?: { width: number; height: number }
  name?: string
  /** Cancels a capture, a batch, and the document it would have opened. */
  signal?: AbortSignal
}

const sitemapSchema = v.object({
  pages: v.array(v.pipe(v.string(), v.url()))
})

/**
 * Posts to the local automation server, retrying once when its connection is being replaced:
 * a batch import can outlive one MCP server, and its first request after the restart may still
 * carry the previous connection's token.
 */
async function postAutomation(
  target: 'capture' | 'sitemap',
  payload: Record<string, unknown>,
  signal?: AbortSignal
): Promise<{ response: Response; body: unknown }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted()
    const files = getAutomationFiles()
    if (!files) {
      throw new Error('Start the local OpenPencil automation server before importing a web page.')
    }
    const response = await fetch(target === 'capture' ? files.capture : files.sitemap, {
      method: 'POST',
      headers: { ...files.headers, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal
    })
    const body: unknown = await response.json().catch(() => null)
    if (response.status !== 401 || attempt === 1) return { response, body }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1_500)
    })
  }
  throw new Error('The local OpenPencil automation server rejected the import.')
}

/** The same-origin pages a site's sitemap declares, discovered on the local automation server. */
export async function discoverWebPages(url: string, signal?: AbortSignal): Promise<string[]> {
  const { response, body } = await postAutomation('sitemap', { url }, signal)
  if (!response.ok) {
    const detail =
      body && typeof body === 'object' && 'error' in body ? String(body.error) : response.statusText
    throw new Error(`Could not read the sitemap of ${url}: ${detail}`)
  }
  return v.parse(sitemapSchema, body).pages
}

/** A captured page's reference screenshot, in the page's own pixels. */
const referenceSchema = v.object({
  src: v.string(),
  width: v.pipe(v.number(), v.minValue(1)),
  height: v.pipe(v.number(), v.minValue(1))
})

const capturedPageSchema = v.object({
  html: v.string(),
  pageBackground: v.optional(v.string()),
  reference: v.optional(referenceSchema),
  svgs: v.optional(v.array(capturedSVGSchema))
})

async function capturePage(url: string, options: WebImportOptions) {
  const { response, body } = await postAutomation(
    'capture',
    {
      url,
      selector: options.selector,
      wait: options.wait,
      scroll: options.scroll,
      viewport: options.viewport,
      reference: options.reference
    },
    options.signal
  )
  if (!response.ok) {
    const detail =
      body && typeof body === 'object' && 'error' in body ? String(body.error) : response.statusText
    throw new Error(`Could not import ${url}: ${detail}`)
  }
  return v.parse(capturedPageSchema, body)
}

function canvasWidth(): number {
  return Math.max(
    0,
    ...[...document.querySelectorAll<HTMLElement>('[data-test-id="canvas-element"]')].map(
      (canvas) => canvas.clientWidth
    )
  )
}

function fitWidth(store: EditorStore, width: number): void {
  const available = Math.max(1, canvasWidth() || window.innerWidth - 520)
  store.state.zoom = Math.max(0.01, Math.min(1, available / Math.max(1, width)))
  store.state.panX = Math.max(0, (available - width * store.state.zoom) / 2)
  store.state.panY = 0
  store.requestRender()
}

/**
 * Renders a live page on the local automation server and opens the inlined result as a new
 * document tab. The browser cannot read another origin's DOM; the server's Playwright can.
 */
export async function importWebPage(
  url: string,
  options: WebImportOptions = {}
): Promise<EditorStore> {
  const { html, pageBackground, reference, svgs } = await capturePage(url, options)
  options.signal?.throwIfAborted()
  const host = new URL(url).hostname.replace(/^www\./i, '') || 'web-page'
  const name = options.name ?? `${host}.html`
  const store = await openFileInNewTab(new File([html], name, { type: 'text/html' }))
  const pageColor = capturedPageColor(pageBackground)
  if (pageColor && (pageColor.r < 0.94 || pageColor.g < 0.94 || pageColor.b < 0.94)) {
    applyCapturedPageBackground(store.graph, pageBackground)
  }
  if (svgs && svgs.length > 0) {
    replaceCapturedSVGImages(store.graph, svgs)
    store.requestRender()
  }
  const viewportWidth = options.viewport?.width ?? 1440
  if (reference) await placeWebImportReference(store, host, reference, { cropWidth: viewportWidth })
  fitWidth(
    store,
    viewportWidth + (reference ? Math.min(reference.width, viewportWidth) + 120 : 0)
  )
  return store
}

function copyPageIntoFrame(
  store: EditorStore,
  graph: Awaited<ReturnType<typeof readDOMGraph>>,
  name: string,
  y: number,
  background: Color | null
): { width: number; height: number } {
  const page = graph.getPages()[0]
  const children = graph.getChildren(page.id)
  const boxes = children.map((child) => graph.getAbsoluteBounds(child.id))
  const minX = Math.min(0, ...boxes.map((box) => box.x))
  const minY = Math.min(0, ...boxes.map((box) => box.y))
  const width = Math.max(1, ...boxes.map((box) => box.x + box.width - minX))
  const height = Math.max(1, ...boxes.map((box) => box.y + box.height - minY))

  store.recordEdit({ label: `Import ${name}` }, () => {
    const frame = store.graph.createNode('FRAME', store.state.currentPageId, {
      name,
      x: 0,
      y,
      width,
      height,
      fills: background
        ? [{ type: 'SOLID', color: background, opacity: 1, visible: true, blendMode: 'NORMAL' }]
        : [],
      clipsContent: true
    })
    for (const [hash, bytes] of graph.images) {
      if (!store.graph.images.has(hash)) store.graph.images.set(hash, new Uint8Array(bytes))
    }
    const copy = (sourceId: string, parentId: string, top: boolean) => {
      const source = graph.getNode(sourceId)
      if (!source) return
      const props = cloneNodeProps(source, null)
      if (top) {
        const bounds = graph.getAbsoluteBounds(sourceId)
        props.x = bounds.x - minX
        props.y = bounds.y - minY
      }
      const clone = store.graph.createNode(source.type, parentId, props)
      for (const childId of source.childIds) copy(childId, clone.id, false)
    }
    for (const child of children) copy(child.id, frame.id, true)
  })
  store.requestRender()
  return { width, height }
}

/**
 * Imports chosen pages of one site into a single document: one frame per page, stacked vertically,
 * each with its original screenshot beside it. The pages don't open tabs of their own. Every page
 * is captured before the document is created, so a failed or cancelled batch leaves no half import.
 */
export async function importWebPages(
  urls: string[],
  options: WebImportOptions & {
    onProgress?: (index: number, total: number, url: string) => void
  } = {}
): Promise<EditorStore> {
  const host = new URL(urls[0] ?? location.href).hostname.replace(/^www\./i, '') || 'web-page'
  const captured: Array<{
    path: string
    page: Awaited<ReturnType<typeof capturePage>>
    graph: Awaited<ReturnType<typeof readDOMGraph>>
  }> = []
  for (const [index, url] of urls.entries()) {
    options.signal?.throwIfAborted()
    options.onProgress?.(index, urls.length, url)
    const page = await capturePage(url, options)
    const path = new URL(url).pathname || '/'
    const graph = await readDOMGraph(page.html, { documentName: path, signal: options.signal })
    captured.push({ path, page, graph })
  }
  options.signal?.throwIfAborted()

  const store = createDocumentTab('design').store
  store.state.documentName = host
  store.state.showUI = true
  const viewportWidth = options.viewport?.width ?? 1440
  let y = 0
  let widest = 0
  for (const { path, page, graph } of captured) {
    const { pageBackground, reference, svgs } = page
    const pageColor = applyCapturedPageBackground(graph, pageBackground)
    if (svgs && svgs.length > 0) replaceCapturedSVGImages(graph, svgs)
    const frame = copyPageIntoFrame(store, graph, `Page — ${path}`, y, pageColor)
    if (reference) {
      await placeWebImportReference(store, host, reference, {
        x: frame.width + 120,
        y,
        name: `Original — ${path}`,
        cropWidth: viewportWidth
      })
    }
    widest = Math.max(
      widest,
      frame.width + (reference ? Math.min(reference.width, viewportWidth) + 120 : 0)
    )
    y += Math.max(frame.height, reference?.height ?? 0) + 240
  }
  fitWidth(store, widest)
  return store
}
