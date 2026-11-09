/* eslint-disable open-pencil/no-core-browser-globals -- Playwright page.evaluate runs in the page. */
/* eslint-disable max-lines -- one Playwright capture pipeline shares its DOM and asset helpers. */
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Browser, BrowserContext, Locator, Page } from '@playwright/test'
import { fromUint8Array, isValid, toUint8Array } from 'js-base64'

import { WEB_SVG_ATTRIBUTE } from '@open-pencil/dom-css/scene-graph'
import type { DesignDocument, DesignLayout, DesignNode } from '@open-pencil/dom-css'
import type { Rect } from '@open-pencil/scene-graph/primitives'

import type { CapturedSVG } from '#core/io/formats/svg/capture'
import { isSVGMarkup } from '#core/io/formats/svg/metadata'

export interface CaptureOptions {
  url: string
  selector?: string
  viewport: { width: number; height: number }
  waitMs: number
  scroll: boolean
  /** Return a full-page screenshot of the source next to the captured HTML. */
  reference?: boolean
  executable?: string
  /** Reports the capture's current stage, for a caller that shows progress. */
  onProgress?: (progress: { phase: string; detail?: string }) => void
}

/** Runs `work` over `items` with at most `limit` requests in flight, keeping their order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await work(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * The Chromium a Playwright release older than the installed one left behind. Playwright names
 * its own build, so a project pinned to a newer release still uses the browser already on disk.
 */
function installedChromium(): string | undefined {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'ms-playwright') : undefined,
    join(homedir(), '.cache', 'ms-playwright')
  ].filter((root): root is string => !!root)
  const executables = [
    ['chrome-win64', 'chrome.exe'],
    ['chrome-win', 'chrome.exe'],
    ['chrome-linux', 'chrome'],
    ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium']
  ]
  for (const root of roots) {
    let entries: string[]
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
    const builds = entries
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => Number(b.slice('chromium-'.length)) - Number(a.slice('chromium-'.length)))
    for (const build of builds) {
      for (const parts of executables) {
        const candidate = join(root, build, ...parts)
        if (existsSync(candidate)) return candidate
      }
    }
  }
  return undefined
}

async function loadPlaywright() {
  try {
    return await import('@playwright/test')
  } catch {
    throw new Error(
      'Capturing a web page needs Playwright. Install it with `bun add -d @playwright/test` and `bunx playwright install chromium`.'
    )
  }
}

export interface CaptureResult {
  html: string
  /**
   * The composed page with resolved styles and captured boxes, so a browser importer can build
   * its layers without parsing the HTML and laying it out a second time.
   */
  document?: DesignDocument
  /** The page's solid background, which the HTML body style alone does not carry into the page. */
  pageBackground?: string
  /** The untouched page as the browser drew it, when `reference` was asked for. */
  reference?: { src: string; width: number; height: number }
  /** SVG vectors the HTML still shows as raster fallbacks, for the importer to replace. */
  svgs?: CapturedSVG[]
  stats: {
    elements: number
    images: number
    imagesInlined: number
    fontFaces: number
    stylesheets: number
    videos: number
    svgs: number
    canvases: number
    bytes: number
    /** The page was too large to clone and is one screenshot instead. */
    fallback?: 'screenshot'
    /** Elements the source page had before the screenshot fallback. */
    sourceElements?: number
  }
}

/** Cloning more than this many elements with inline styles exhausts the renderer. */
const MAX_DOM_ELEMENTS = 12_000

async function settle(page: Page, waitMs: number) {
  await page.waitForLoadState('domcontentloaded')
  // Persistent analytics and chat sockets never reach networkidle; a short quiet window is enough.
  await page.waitForLoadState('networkidle', { timeout: 2_500 }).catch(() => undefined)
  await page.evaluate(async () => {
    const timeout = () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 1_500)
      })
    await Promise.race([document.fonts.ready, timeout()])
    await Promise.all(
      [...document.images].map((image) =>
        Promise.race([image.decode().catch(() => undefined), timeout()])
      )
    )
  })
  if (waitMs > 0) await page.waitForTimeout(waitMs)
}

async function scrollThrough(page: Page) {
  await page.evaluate(() => {
    // Lazy images below the fold never load while the page sits at the top.
    for (const image of document.images) {
      image.loading = 'eager'
      image.decoding = 'async'
    }
  })
  await page.evaluate(async () => {
    const step = Math.max(1, window.innerHeight * 0.7)
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y)
      await new Promise((resolve) => {
        setTimeout(resolve, 70)
      })
    }
    window.scrollTo(0, 0)
    await new Promise((resolve) => {
      setTimeout(resolve, 100)
    })
    await Promise.all(
      [...document.images].map((image) =>
        Promise.race([
          image.decode().catch(() => undefined),
          new Promise((resolve) => {
            setTimeout(resolve, 1_500)
          })
        ])
      )
    )
  })
}

/** Accepts a cookie banner before the page is cloned or screenshotted. */
async function dismissConsent(page: Page) {
  const clicked = await page.evaluate(() => {
    const words = [
      'allow all',
      'accept all',
      'accept',
      'akzeptieren',
      'alle akzeptieren',
      'zustimmen',
      'i agree'
    ]
    const visible = (element: Element) => {
      const style = getComputedStyle(element)
      const box = element.getBoundingClientRect()
      return (
        style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0
      )
    }
    const scopes = [
      document.querySelector('#CybotCookiebotDialog'),
      ...document.querySelectorAll(
        '[id*="cookiebot"], [class*="cookiebot"], [class*="consent"], [role="dialog"]'
      )
    ].filter((scope): scope is Element => scope !== null)
    const roots = scopes.length > 0 ? scopes : [document.body]
    for (const root of roots) {
      const buttons = root.querySelectorAll<HTMLElement>(
        'button, [role="button"], a, input[type="button"], input[type="submit"]'
      )
      for (const button of buttons) {
        if (!visible(button)) continue
        const text = button.textContent.trim().toLowerCase()
        if (!words.some((word) => text === word || text.startsWith(`${word} `))) continue
        button.click()
        return true
      }
    }
    return false
  })
  if (clicked) await page.waitForTimeout(250)
}

/** Text a close control may carry, in the languages a captured page commonly uses. */
export const OVERLAY_DISMISS_LABELS = [
  'close',
  'schließen',
  'schliessen',
  '×',
  'x',
  'accept',
  'accept all',
  'allow all',
  'akzeptieren',
  'alle akzeptieren',
  'zustimmen',
  'i agree'
] as const

/**
 * Closes a consent or newsletter layer covering most of the viewport, so the capture shows the
 * page underneath. A layer kept open by the page is a state of its own, not the default page.
 */
async function dismissOverlays(page: Page) {
  const dismiss = () =>
    page.evaluate((words) => {
      const viewport = window.innerWidth * window.innerHeight
      const layers = [...document.querySelectorAll('body *')].filter((element) => {
        if (!(element instanceof HTMLElement)) return false
        const style = getComputedStyle(element)
        if (style.position !== 'fixed' && style.position !== 'sticky') return false
        const box = element.getBoundingClientRect()
        return box.width * box.height > viewport * 0.15
      })
      for (const layer of layers) {
        const candidates = [
          ...layer.querySelectorAll<HTMLElement>(
            'button, [role="button"], a, [class*="close"], [class*="dismiss"]'
          )
        ]
        const close = candidates.find((candidate) => {
          const text = candidate.textContent.trim().toLowerCase()
          const label = (candidate.getAttribute('aria-label') ?? '').toLowerCase()
          return words.some((word) => text === word || label.includes(word))
        })
        if (!close) continue
        close.click()
        return true
      }
      return false
    }, OVERLAY_DISMISS_LABELS)
  try {
    if (await dismiss()) await page.waitForTimeout(250)
  } catch (error) {
    console.warn('Could not dismiss a page overlay:', error)
  }
}

/** Resolves the relative URLs a stylesheet keeps, now that it is inlined into the page. */
function resolveStylesheetURLs(css: string, base: string): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, _quote, url: string) => {
    if (!url || /^(data:|blob:|#)/i.test(url)) return match
    try {
      return `url("${new URL(url, base).href}")`
    } catch {
      return match
    }
  })
}

/** Reads linked stylesheets through the browser context, which has no page CORS boundary. */
async function inlineLinkedStylesheets(context: BrowserContext, html: string): Promise<string> {
  const matches = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/gi)]
  const replacements = await mapLimit(matches, 6, async (match) => {
    const tag = match[0]
    const href = tag.match(/\bhref="([^"]+)"/i)?.[1]
    if (!tag || !href) return null
    try {
      const response = await context.request.get(href, { timeout: 8_000 })
      if (!response.ok()) return null
      const css = await response.text()
      if (css.length > 2_000_000) return null
      const resolved = resolveStylesheetURLs(css, response.url())
      return { tag, style: `<style>${resolved.replaceAll('</style', '<\\/style')}</style>` }
    } catch (error) {
      // An unreachable stylesheet stays a link, as it was captured.
      console.warn(`Could not inline stylesheet ${href}:`, error)
      return null
    }
  })
  let next = html
  for (const replacement of replacements) {
    if (replacement) next = next.replace(replacement.tag, replacement.style)
  }
  return next
}

function fontMime(url: string, contentType: string | null): string {
  if (contentType?.startsWith('font/')) return contentType.split(';')[0] ?? 'font/woff2'
  if (contentType?.startsWith('application/font')) return contentType.split(';')[0] ?? 'font/woff2'
  if (url.includes('.woff2')) return 'font/woff2'
  if (url.includes('.woff')) return 'font/woff'
  if (url.includes('.ttf')) return 'font/ttf'
  if (url.includes('.otf')) return 'font/otf'
  return 'application/octet-stream'
}

/**
 * Fetches the files an inlined @font-face rule names through the browser context and embeds
 * them as data URLs. The app imports captured HTML from its own origin, where the page's
 * fonts would otherwise be blocked by CORS; embedded bytes also keep the capture self-contained.
 */
async function inlineFontSources(
  context: BrowserContext,
  html: string,
  baseURL: string
): Promise<string> {
  const urls = new Set<string>()
  for (const block of html.matchAll(/@font-face\s*{[^}]*}/gi)) {
    for (const match of block[0].matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
      const url = match[2]
      if (url && !/^data:/i.test(url)) urls.add(url)
    }
  }
  const replacements = new Map<string, string>()
  let total = 0
  await Promise.all(
    [...urls].slice(0, 32).map(async (url) => {
      if (total >= 32 * 1024 * 1024) return
      try {
        const absolute = new URL(url, baseURL).href
        const response = await context.request.get(absolute, { timeout: 8_000 })
        if (!response.ok()) return
        const body = await response.body()
        if (body.length > 8 * 1024 * 1024) return
        const mime = fontMime(absolute, response.headers()['content-type'] ?? null)
        if (mime === 'text/html') return
        total += body.length
        replacements.set(url, `data:${mime};base64,${fromUint8Array(new Uint8Array(body))}`)
      } catch (error) {
        // The original URL stays, and the importer falls back to another source.
        console.warn(`Could not inline font ${url}:`, error)
      }
    })
  )
  let next = html
  for (const [url, data] of replacements) next = next.split(url).join(data)
  return next
}

/**
 * Scroll-reveal pages leave sections below the fold at opacity 0. Pruning would delete their
 * content before it ever appears, so show in-flow elements that occupy space first.
 */
async function revealAnimatedContent(page: Page) {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll<HTMLElement>('body *')) {
      const style = getComputedStyle(element)
      if (style.opacity !== '0') continue
      if (style.position !== 'static' && style.position !== 'relative') continue
      const rect = element.getBoundingClientRect()
      if (rect.width < 2 || rect.height < 2) continue
      element.style.opacity = '1'
      element.style.transform = 'none'
    }
  })
  await page.waitForTimeout(100)
}

function imageMime(url: string, contentType: string | null): string {
  if (contentType?.startsWith('image/')) return contentType.split(';')[0] ?? 'image/jpeg'
  if (url.includes('.png')) return 'image/png'
  if (url.includes('.webp')) return 'image/webp'
  if (url.includes('.svg')) return 'image/svg+xml'
  if (url.includes('.gif')) return 'image/gif'
  return 'image/jpeg'
}

/**
 * Images from another origin fail the page's own fetch. Fetch them through the browser context
 * instead, where no CORS policy applies, so the capture keeps the artwork it displayed.
 */
async function inlineRemoteImages(
  context: BrowserContext,
  html: string
): Promise<{ html: string; inlined: number; replacements: Map<string, string> }> {
  const urls = new Set<string>()
  for (const match of html.matchAll(/<img\b[^>]*\bsrc="(https?:[^"]+)"/gi)) {
    if (match[1]) urls.add(match[1])
  }
  let total = 0
  const entries = await mapLimit([...urls].slice(0, 128), 8, async (url) => {
    if (total >= 32 * 1024 * 1024) return null
    try {
      const absolute = new URL(url.replaceAll('&amp;', '&')).href
      const response = await context.request.get(absolute, { timeout: 8_000 })
      if (!response.ok()) return null
      const body = await response.body()
      if (body.length > 8 * 1024 * 1024) return null
      if (total + body.length > 32 * 1024 * 1024) return null
      total += body.length
      const mime = imageMime(absolute, response.headers()['content-type'] ?? null)
      return [url, `data:${mime};base64,${fromUint8Array(new Uint8Array(body))}`] as const
    } catch (error) {
      console.warn(`Could not inline image ${url}:`, error)
      return null
    }
  })
  let next = html
  let inlined = 0
  const replacements = new Map<string, string>()
  for (const entry of entries) {
    if (!entry) continue
    const [url, data] = entry
    next = next.split(`src="${url}"`).join(`src="${data}"`)
    replacements.set(url, data)
    inlined++
  }
  return { html: next, inlined, replacements }
}

/** Applies the browser-context image data URLs and SVG marker remap to the captured model. */
function applyCapturedAssetReplacements(
  document: DesignDocument,
  replacements: ReadonlyMap<string, string>,
  remap: ReadonlyMap<number, number>
): void {
  const replaceURLs = (value: string): string => {
    let next = value
    for (const [url, data] of replacements) {
      if (next.includes(url)) next = next.split(url).join(data)
    }
    return next
  }
  const walk = (node: DesignNode) => {
    if (node.type === 'text') return
    if (node.attrs.src && replacements.has(node.attrs.src)) {
      node.attrs.src = replacements.get(node.attrs.src) ?? node.attrs.src
    }
    const marker = node.attrs[WEB_SVG_ATTRIBUTE]
    if (marker !== undefined) {
      const index = Number.parseInt(marker, 10)
      const remapped = remap.get(index)
      if (remapped !== undefined) node.attrs[WEB_SVG_ATTRIBUTE] = String(remapped)
    }
    if (node.computedStyle) {
      for (const [property, value] of Object.entries(node.computedStyle)) {
        if (value.includes('url(')) node.computedStyle[property] = replaceURLs(value)
      }
    }
    for (const child of node.children) walk(child)
  }
  for (const child of document.children) walk(child)
}

/**
 * Removes what the browser does not paint: display-none/visibility-hidden branches, empty
 * zero-box leaves, and wrappers left without a visible descendant. Huge menus and tracking
 * widgets otherwise inflate a page to tens of thousands of elements, all of which would receive
 * inline styles for nothing.
 */
async function pruneHidden(page: Page, selector?: string): Promise<number> {
  return page.evaluate((target) => {
    const root = target ? document.querySelector(target) : document.body
    if (!root) return 0

    /** The elements a browser composes: slot assignments, an open shadow root's, or the light DOM's. */
    function renderedChildren(element: Element): Element[] {
      let nodes: Node[]
      if (element instanceof HTMLSlotElement) {
        const assigned = element.assignedNodes({ flatten: true })
        nodes = assigned.length > 0 ? assigned : [...element.childNodes]
      } else {
        nodes = element.shadowRoot ? [...element.shadowRoot.childNodes] : [...element.childNodes]
      }
      return nodes.filter((node): node is Element => node.nodeType === Node.ELEMENT_NODE)
    }

    const elements: Element[] = []
    const walk = (element: Element) => {
      for (const child of renderedChildren(element)) {
        elements.push(child)
        walk(child)
      }
    }
    walk(root)

    const nonRendered = new Set(['STYLE', 'LINK', 'SCRIPT', 'META', 'TITLE', 'TEMPLATE', 'BASE'])
    // Children first: a removed wrapper takes its branch with it.
    for (const element of elements.reverse()) {
      if (nonRendered.has(element.tagName)) continue
      if (!(element instanceof HTMLElement)) continue
      const style = getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        element.remove()
        continue
      }
      const box = element.getBoundingClientRect()
      // Visually hidden text (a screen-reader heading, an sr-only label) is clipped to a
      // one-pixel box. Rendering it would duplicate a heading or add invisible copy to the page.
      const clipped = style.clip !== 'auto' || style.clipPath !== 'none'
      if (clipped && box.width <= 2 && box.height <= 2) {
        element.remove()
        continue
      }
      if (box.width > 0 && box.height > 0) continue
      if (element.children.length === 0) element.remove()
    }

    let remaining = 0
    const count = (element: Element) => {
      remaining++
      for (const child of renderedChildren(element)) count(child)
    }
    count(root)
    return remaining
  }, selector)
}

/**
 * Canvas and iframe pixels cannot be cloned as DOM. Replace each visible one with the pixels the
 * browser actually rendered, so interactive artwork and embedded widgets keep their appearance.
 */
async function rasterizeDynamicContent(page: Page): Promise<void> {
  const candidates = await page.evaluate(() => {
    document
      .querySelectorAll('[data-openpencil-dynamic]')
      .forEach((element) => element.removeAttribute('data-openpencil-dynamic'))
    return [...document.querySelectorAll('canvas,iframe,video:not([poster])')]
      .map((element, index) => {
        const rect = element.getBoundingClientRect()
        return { element, index, rect }
      })
      .filter(({ rect }) => rect.width >= 2 && rect.height >= 2)
      .map(({ element, index }) => {
        element.setAttribute('data-openpencil-dynamic', String(index))
        return { index, tag: element.tagName.toLowerCase() }
      })
  })
  if (candidates.length === 0) return

  const replacements: Array<{ index: number; data: string }> = []
  for (const candidate of candidates) {
    const locator = page.locator(`[data-openpencil-dynamic="${candidate.index}"]`)
    try {
      const buffer = await locator.screenshot({ type: 'png', timeout: 10_000 })
      replacements.push({
        index: candidate.index,
        data: `data:image/png;base64,${fromUint8Array(buffer)}`
      })
    } catch (error) {
      console.warn(`Could not rasterize ${candidate.tag}:`, error)
    }
  }
  if (replacements.length === 0) return

  await page.evaluate((items) => {
    for (const { index, data } of items) {
      const element = document.querySelector(`[data-openpencil-dynamic="${index}"]`)
      if (!element) continue
      const computed = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      let css = ''
      for (const property of computed) {
        const value = computed.getPropertyValue(property)
        if (value) css += `${property}:${value};`
      }
      const image = document.createElement('img')
      image.src = data
      image.alt = ''
      image.style.cssText = `${css}width:${rect.width}px;height:${rect.height}px;object-fit:fill;`
      element.replaceWith(image)
    }
  }, replacements)
}

/**
 * An SVG the page showed, as the capture saw it: inline markup, or the URL or data URL its
 * `<img>` drew, with the box the page laid it out in.
 */
interface CaptureSVGCandidate {
  svg?: string
  source?: string
  data?: string
  x: number
  y: number
  width: number
  height: number
  name?: string
}

/** The most one SVG source may hold, and the most all of them together. */
const MAX_SVG_SOURCE_CHARS = 512 * 1024
const MAX_SVG_SOURCES_CHARS = 8 * 1024 * 1024

/** The text a `data:` URL carries, whether it is Base64 or percent-encoded. */
function decodeDataURLText(data: string): string | null {
  const comma = data.indexOf(',')
  if (comma === -1) return null
  const metadata = data.slice(5, comma).toLowerCase()
  const body = data.slice(comma + 1)
  try {
    if (metadata.includes(';base64')) {
      if (!isValid(body)) return null
      return new TextDecoder().decode(toUint8Array(body))
    }
    return decodeURIComponent(body)
  } catch {
    return null
  }
}

/**
 * The source markup of one captured SVG. The page already inlined same-origin files; anything it
 * could not read is fetched through the browser context, which has no page CORS boundary.
 */
async function captureSVGSource(
  context: BrowserContext,
  candidate: CaptureSVGCandidate,
  baseURL: string
): Promise<string | null> {
  if (candidate.svg) return candidate.svg
  const reference = candidate.data ?? candidate.source
  if (!reference) return null
  if (reference.startsWith('data:')) return decodeDataURLText(reference)
  try {
    const response = await context.request.get(new URL(reference, baseURL).href, {
      timeout: 8_000
    })
    if (!response.ok()) return null
    const text = await response.text()
    return text.length > MAX_SVG_SOURCE_CHARS ? null : text
  } catch (error) {
    console.warn(`Could not read SVG ${reference}:`, error)
    return null
  }
}

/**
 * The readable SVG sources among the captured candidates, and where each kept one moved to. The
 * HTML's markers are renumbered to match, so a source that could not be read keeps its raster.
 */
async function resolveCapturedSVGs(
  context: BrowserContext,
  candidates: CaptureSVGCandidate[],
  baseURL: string
): Promise<{ svgs: CapturedSVG[]; remap: Map<number, number> }> {
  const sources = await Promise.all(
    candidates.map((candidate) => captureSVGSource(context, candidate, baseURL))
  )
  const svgs: CapturedSVG[] = []
  const remap = new Map<number, number>()
  let total = 0
  for (const [index, candidate] of candidates.entries()) {
    const svg = sources[index]
    if (!svg || svg.length > MAX_SVG_SOURCE_CHARS || !isSVGMarkup(svg)) continue
    if (total + svg.length > MAX_SVG_SOURCES_CHARS) break
    total += svg.length
    remap.set(index, svgs.length)
    svgs.push({
      svg,
      x: candidate.x,
      y: candidate.y,
      width: candidate.width,
      height: candidate.height,
      ...(candidate.name ? { name: candidate.name } : {})
    })
  }
  return { svgs, remap }
}

/** Renumbers captured SVG markers after unreadable sources were dropped. */
function remapSVGMarkers(html: string, remap: Map<number, number>): string {
  const marker = new RegExp(`(\\s${WEB_SVG_ATTRIBUTE}=")(\\d+)(")`, 'g')
  return html.replace(marker, (_match, before: string, index: string, after: string) => {
    const next = remap.get(Number(index))
    return next === undefined ? '' : `${before}${next}${after}`
  })
}

/** The element a selector names, so a reference or fallback shows what the import shows. */
async function selectorTarget(
  page: Page,
  selector: string | undefined
): Promise<{ locator: Locator; box: { width: number; height: number } } | null> {
  if (!selector) return null
  const locator = page.locator(selector).first()
  const box = await locator.boundingBox()
  if (!box || box.width < 1 || box.height < 1) return null
  return { locator, box }
}

async function screenshotFallback(
  page: Page,
  sourceElements: number,
  selector?: string
): Promise<CaptureResult> {
  const pageBackground = await page.evaluate(() =>
    [
      getComputedStyle(document.body).backgroundColor,
      getComputedStyle(document.documentElement).backgroundColor
    ].find(
      (color) => color && color !== 'transparent' && !/^rgba?\(0,\s*0,\s*0,\s*0\)$/i.test(color)
    )
  )
  const target = await selectorTarget(page, selector)
  const size = target
    ? { width: Math.round(target.box.width), height: Math.round(target.box.height) }
    : await page.evaluate(() => ({
        width: Math.max(
          document.documentElement.scrollWidth,
          document.body.scrollWidth,
          window.innerWidth
        ),
        height: Math.max(
          document.documentElement.scrollHeight,
          document.body.scrollHeight,
          window.innerHeight
        )
      }))
  const image = target
    ? await target.locator.screenshot({ type: 'jpeg', quality: 82, timeout: 120_000 })
    : await page.screenshot({
        fullPage: true,
        type: 'jpeg',
        quality: 82,
        timeout: 120_000
      })
  const data = `data:image/jpeg;base64,${fromUint8Array(image)}`
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}</style></head><body><img alt="Imported page" src="${data}" style="display:block;width:${size.width}px;height:${size.height}px"></body></html>`
  return {
    html,
    pageBackground,
    stats: {
      elements: 1,
      images: 1,
      imagesInlined: 1,
      fontFaces: 0,
      stylesheets: 0,
      videos: 0,
      svgs: 0,
      canvases: 0,
      bytes: Buffer.byteLength(html),
      fallback: 'screenshot',
      sourceElements
    }
  }
}

export async function captureWebPage(args: CaptureOptions): Promise<CaptureResult> {
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  const report = (phase: string, detail?: string) => args.onProgress?.({ phase, detail })
  try {
    report('launching')
    const { chromium } = await loadPlaywright()
    browser = await chromium.launch({
      headless: true,
      executablePath: args.executable ?? installedChromium()
    })
    context = await browser.newContext({
      viewport: args.viewport,
      deviceScaleFactor: 1,
      locale: 'en-US'
    })
    const page = await context.newPage()
    report('navigating', args.url)
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    report('settling')
    await settle(page, args.waitMs)
    if (args.scroll) {
      report('scrolling')
      await scrollThrough(page)
      await settle(page, Math.min(args.waitMs, 250))
    }
    report('dismissing overlays')
    await dismissConsent(page)
    await dismissOverlays(page)
    await revealAnimatedContent(page)
    report('rasterizing canvases')
    await rasterizeDynamicContent(page)

    let reference: CaptureResult['reference']
    if (args.reference) {
      report('capturing reference')
      try {
        const target = await selectorTarget(page, args.selector)
        const size = target
          ? { width: Math.round(target.box.width), height: Math.round(target.box.height) }
          : await page.evaluate(() => ({
              width: Math.max(
                document.documentElement.scrollWidth,
                document.body.scrollWidth,
                window.innerWidth
              ),
              height: Math.max(
                document.documentElement.scrollHeight,
                document.body.scrollHeight,
                window.innerHeight
              )
            }))
        const image = target
          ? await target.locator.screenshot({ type: 'jpeg', quality: 82, timeout: 120_000 })
          : await page.screenshot({ fullPage: true, type: 'jpeg', quality: 82 })
        reference = {
          src: `data:image/jpeg;base64,${fromUint8Array(image)}`,
          width: size.width,
          height: size.height
        }
      } catch (error) {
        console.warn('Could not capture the original page reference:', error)
      }
    }

    // A page with tens of thousands of elements cannot be cloned with every computed style; the
    // renderer runs out of memory. Prune what is not painted first; only a page still too large
    // after that falls back to one screenshot.
    report('pruning hidden layers')
    const sourceElements = await pruneHidden(page, args.selector)
    if (sourceElements > MAX_DOM_ELEMENTS) {
      return {
        ...(await screenshotFallback(page, sourceElements, args.selector)),
        reference
      }
    }

    report('cloning the page')
    const captured = await page.evaluate(
      // oxlint-disable-next-line complexity -- one browser-side walk over the captured DOM
      async ({ selector, svgAttribute }) => {
        const root = selector ? document.querySelector(selector) : document.body
        if (!root) throw new Error(`Selector "${selector}" did not match anything.`)

        /** Nodes a browser renders: slot content, an open shadow root's, or the light DOM's. */
        function renderedChildNodes(element: Element): Node[] {
          if (element instanceof HTMLSlotElement) {
            const assigned = element.assignedNodes({ flatten: true })
            if (assigned.length > 0) return assigned
          }
          return element.shadowRoot ? [...element.shadowRoot.childNodes] : [...element.childNodes]
        }

        function renderedChildren(element: Element): Element[] {
          return renderedChildNodes(element).filter(
            (node): node is Element => node.nodeType === Node.ELEMENT_NODE
          )
        }

        /** Clones the rendered tree, text included and open shadow roots flattened into hosts. */
        function cloneRendered(source: Element): Element {
          const clone = source.cloneNode(false) as Element
          for (const child of renderedChildNodes(source)) {
            clone.append(
              child.nodeType === Node.ELEMENT_NODE
                ? cloneRendered(child as Element)
                : child.cloneNode(true)
            )
          }
          return clone
        }

        /** The elements whose styles the clone needs, in the order the browser renders them. */
        function renderedElements(rootElement: Element): Element[] {
          const elements = [rootElement]
          const walk = (element: Element) => {
            for (const child of renderedChildren(element)) {
              elements.push(child)
              walk(child)
            }
          }
          walk(rootElement)
          return elements
        }

        function toRect(rect: DOMRectReadOnly, origin: DOMRectReadOnly): Rect {
          return {
            x: rect.left - origin.left,
            y: rect.top - origin.top,
            width: rect.width,
            height: rect.height
          }
        }

        function hasArea(rect: DOMRectReadOnly): boolean {
          return rect.width > 0 && rect.height > 0
        }

        /** Display values whose box flows in a line, so its text belongs to the lines around it. */
        function isInlineFlow(display: string): boolean {
          return display === 'inline' || display === 'contents'
        }

        /** The text nodes an element lays out in its own lines: its own, and its inline descendants'. */
        function lineTextNodes(element: Element): Text[] {
          const texts: Text[] = []
          for (const child of renderedChildNodes(element)) {
            if (child.nodeType === Node.TEXT_NODE) {
              if ((child.nodeValue ?? '').trim().length > 0) texts.push(child as Text)
            } else if (child.nodeType === Node.ELEMENT_NODE) {
              const childElement = child as Element
              if (isInlineFlow(getComputedStyle(childElement).display)) {
                texts.push(...lineTextNodes(childElement))
              }
            }
          }
          return texts
        }

        function boundsOf(rects: readonly Rect[]): Rect {
          const left = Math.min(...rects.map((rect) => rect.x))
          const top = Math.min(...rects.map((rect) => rect.y))
          const right = Math.max(...rects.map((rect) => rect.x + rect.width))
          const bottom = Math.max(...rects.map((rect) => rect.y + rect.height))
          return { x: left, y: top, width: right - left, height: bottom - top }
        }

        /** Rects of text on one line overlap vertically by more than half; each line spans its rects. */
        function groupIntoLines(rects: readonly Rect[]): Rect[] {
          const lines: Rect[][] = []
          for (const rect of [...rects].sort((a, b) => a.y - b.y || a.x - b.x)) {
            const line = lines.find((group) => {
              const span = boundsOf(group)
              const overlap =
                Math.min(span.y + span.height, rect.y + rect.height) - Math.max(span.y, rect.y)
              return overlap > Math.min(span.height, rect.height) / 2
            })
            if (line) line.push(rect)
            else lines.push([rect])
          }
          return lines.map((group) => boundsOf(group))
        }

        function measureElement(element: Element, origin: DOMRectReadOnly): DesignLayout {
          const layout: DesignLayout = { box: toRect(element.getBoundingClientRect(), origin) }
          if (isInlineFlow(getComputedStyle(element).display)) {
            const fragments = Array.from(element.getClientRects()).filter(hasArea)
            if (fragments.length > 0) {
              layout.fragments = fragments.map((rect) => toRect(rect, origin))
            }
            return layout
          }
          const rects = lineTextNodes(element).flatMap((text) => {
            const range = element.ownerDocument.createRange()
            range.selectNodeContents(text)
            return Array.from(range.getClientRects())
              .filter(hasArea)
              .map((rect) => toRect(rect, origin))
          })
          const lines = groupIntoLines(rects)
          if (lines.length > 0) layout.lines = lines
          return layout
        }

        function styleRecord(style: CSSStyleDeclaration): Record<string, string> {
          const record: Record<string, string> = {}
          for (const property of Array.from(style)) {
            const value = style.getPropertyValue(property)
            if (value) record[property] = value
          }
          return record
        }

        const sourceElements = renderedElements(root)
        const clone = cloneRendered(root)
        const targetElements = renderedElements(clone)

        const stats = {
          images: 0,
          imagesInlined: 0,
          fontFaces: 0,
          stylesheets: 0,
          videos: 0,
          svgs: 0,
          canvases: 0
        }

        const capturedSVGs: CaptureSVGCandidate[] = []

        /** Bounds in page pixels, which the imported document uses as its own coordinates. */
        function svgPageRect(element: Element): Rect {
          const rect = element.getBoundingClientRect()
          return {
            x: rect.left + window.scrollX,
            y: rect.top + window.scrollY,
            width: rect.width,
            height: rect.height
          }
        }

        /** A layer name from the element's own labels, then its id, then the file it came from. */
        function svgName(element: Element, fallback: string): string {
          const alt = element.getAttribute('alt')?.trim()
          if (alt) return alt
          const label = element.getAttribute('aria-label')?.trim()
          if (label) return label
          const title = element.querySelector('title')?.textContent.trim()
          if (title) return title
          const id = element.getAttribute('id')?.trim()
          if (id) return id
          return fallback
        }

        function svgFileName(url: string): string {
          if (url.startsWith('data:')) return ''
          try {
            const name = new URL(url, document.baseURI).pathname.split('/').pop() ?? ''
            return name.replace(/\.svgz?$/i, '')
          } catch {
            return ''
          }
        }

        function recordSVG(candidate: CaptureSVGCandidate): number | null {
          if (capturedSVGs.length >= 200) return null
          capturedSVGs.push(candidate)
          return capturedSVGs.length - 1
        }

        async function toDataURL(url: string, limit = 8 * 1024 * 1024): Promise<string> {
          const absolute = new URL(url, document.baseURI).href
          if (absolute.startsWith('data:')) return absolute
          try {
            const response = await fetch(absolute, {
              credentials: 'include',
              signal: AbortSignal.timeout(10_000)
            })
            if (!response.ok) return absolute
            const blob = await response.blob()
            // A large asset stays a URL rather than making the capture enormous.
            if (blob.size > limit) return absolute
            return await new Promise<string>((resolve, reject) => {
              const reader = new FileReader()
              reader.onload = () => {
                if (typeof reader.result === 'string') resolve(reader.result)
                else reject(new Error('Could not read asset'))
              }
              reader.onerror = () => reject(reader.error ?? new Error('Could not read asset'))
              reader.readAsDataURL(blob)
            })
          } catch {
            return absolute
          }
        }

        async function rasterizeSVGData(
          sourceData: string,
          width: number,
          height: number
        ): Promise<string | null> {
          try {
            const image = new Image()
            image.src = sourceData
            await image.decode()
            const canvas = document.createElement('canvas')
            canvas.width = Math.min(2048, Math.max(1, Math.round(width || image.naturalWidth)))
            canvas.height = Math.min(2048, Math.max(1, Math.round(height || image.naturalHeight)))
            const context = canvas.getContext('2d')
            if (!context) return null
            context.drawImage(image, 0, 0, canvas.width, canvas.height)
            return canvas.toDataURL('image/png')
          } catch {
            return null
          }
        }

        /**
         * Paints a CSS filter into the pixels. Logo walls commonly turn dark artwork white with
         * `brightness(0) invert(1)`; the imported image keeps its pixels, so without baking the
         * filter its logos would draw black on the page's dark background and disappear.
         */
        async function filteredImage(
          sourceData: string,
          filter: string,
          width: number,
          height: number
        ): Promise<string | null> {
          try {
            const image = new Image()
            image.src = sourceData
            await image.decode()
            const canvas = document.createElement('canvas')
            const scale = 2
            canvas.width = Math.min(
              2048,
              Math.max(1, Math.round((width || image.naturalWidth) * scale))
            )
            canvas.height = Math.min(
              2048,
              Math.max(1, Math.round((height || image.naturalHeight) * scale))
            )
            const context = canvas.getContext('2d')
            if (!context) return null
            context.filter = filter
            context.drawImage(image, 0, 0, canvas.width, canvas.height)
            return canvas.toDataURL('image/png')
          } catch {
            return null
          }
        }

        function inlineURLs(value: string): Promise<string> {
          const urls = [...value.matchAll(/url\((['"]?)(.*?)\1\)/g)].map((match) => match[2])
          return (async () => {
            let next = value
            for (const url of urls) {
              if (!url || url.startsWith('data:')) continue
              const data = await toDataURL(url)
              next = next.split(url).join(data)
            }
            return next
          })()
        }

        const styleRecords = new Map<Element, Record<string, string>>()
        const sourceByTarget = new Map<Element, Element>()
        for (let index = 0; index < sourceElements.length; index++) {
          const source = sourceElements[index]
          const target = targetElements[index] as HTMLElement
          const computed = getComputedStyle(source)
          let css = ''
          const record: Record<string, string> = {}
          for (const property of computed) {
            const value = computed.getPropertyValue(property)
            if (value) {
              css += `${property}:${value};`
              record[property] = value
            }
          }
          target.style.cssText = css
          styleRecords.set(target, record)
          sourceByTarget.set(target, source)
          target.removeAttribute('class')
          // SVG defs, gradients, and clips are referenced by id, so an inline SVG keeps its ids.
          if (!(target instanceof SVGElement)) target.removeAttribute('id')
        }

        const noPseudoChildren = new Set(['IMG', 'INPUT', 'TEXTAREA', 'SELECT', 'VIDEO', 'CANVAS'])
        const seenOverlays = new Set<string>()
        for (let index = 0; index < sourceElements.length; index++) {
          if (seenOverlays.size >= 300) break
          const source = sourceElements[index]
          const target = targetElements[index] as HTMLElement
          if (noPseudoChildren.has(source.tagName) || getComputedStyle(source).display === 'none') {
            continue
          }
          for (const pseudo of ['::before', '::after'] as const) {
            const style = getComputedStyle(source, pseudo)
            const content = style.content
            if (content === 'none' || content === 'normal') continue
            const text =
              content &&
              content !== '""' &&
              content !== "''" &&
              !content.startsWith('url(') &&
              !content.startsWith('counter(')
                ? content.replace(/^['"]|['"]$/g, '')
                : ''
            let image = style.backgroundImage
            const pseudoelementWidth = Number.parseFloat(style.width) || 0
            const pseudoelementHeight = Number.parseFloat(style.height) || 0
            if (image.includes('url(')) {
              // Small pseudo backgrounds are usually icons; larger ones are repeated
              // third-party artwork already carried by the element itself.
              if (pseudoelementWidth > 256 || pseudoelementHeight > 256) continue
              image = await inlineURLs(image)
            }
            const color = style.backgroundColor
            const noImage = !image || image === 'none'
            const noColor = !color || color === 'rgba(0, 0, 0, 0)' || color === 'transparent'
            // A spinner ring is a border on a pseudo-element, with no background or text.
            const drawsBorder = (
              [
                ['border-top-width', 'border-top-style'],
                ['border-right-width', 'border-right-style'],
                ['border-bottom-width', 'border-bottom-style'],
                ['border-left-width', 'border-left-style']
              ] as const
            ).some(([width, borderStyle]) => {
              const visible = style.getPropertyValue(borderStyle) !== 'none'
              return visible && (Number.parseFloat(style.getPropertyValue(width)) || 0) > 0
            })
            const drawsShadow = style.boxShadow !== 'none'
            if (!text && noImage && noColor && !drawsBorder && !drawsShadow) continue
            if (pseudoelementWidth < 0.5 || pseudoelementHeight < 0.5) continue

            // The overlay is a child of the element's clone, as the pseudo-element was, so it keeps
            // the same containing block. Copying its used box keeps an accent bar a bar instead of
            // letting it fill and cover the card.
            const position = style.position
            const positioned = position === 'absolute' || position === 'fixed'
            const key = `${Math.round(pseudoelementWidth)}:${Math.round(pseudoelementHeight)}:${style.left}:${style.top}:${style.right}:${style.bottom}:${image}:${color}:${text}:${style.transform}`
            if (seenOverlays.has(key)) continue
            if (seenOverlays.size >= 300) break
            seenOverlays.add(key)

            const overlay = document.createElement(text ? 'span' : 'div')
            overlay.style.cssText = [
              `position:${positioned ? position : 'static'}`,
              positioned ? `left:${style.left}` : '',
              positioned ? `top:${style.top}` : '',
              positioned ? `right:${style.right}` : '',
              positioned ? `bottom:${style.bottom}` : '',
              positioned ? `width:${pseudoelementWidth}px` : '',
              positioned ? `height:${pseudoelementHeight}px` : '',
              `box-sizing:${style.boxSizing}`,
              `display:${style.display}`,
              `margin:${style.margin}`,
              `padding:${style.padding}`,
              // A spinner ring uses one transparent side, which the border shorthand cannot hold.
              `border-width:${style.borderWidth}`,
              `border-style:${style.borderStyle}`,
              `border-color:${style.borderColor}`,
              `border-radius:${style.borderRadius}`,
              `transform:${style.transform}`,
              `transform-origin:${style.transformOrigin}`,
              `clip-path:${style.clipPath}`,
              `mask-image:${style.maskImage}`,
              `mask-size:${style.maskSize}`,
              `mask-position:${style.maskPosition}`,
              `mask-repeat:${style.maskRepeat}`,
              `overflow:${style.overflow}`,
              `box-shadow:${style.boxShadow}`,
              `mix-blend-mode:${style.mixBlendMode}`,
              `filter:${style.filter}`,
              `background-image:${noImage ? 'none' : image}`,
              `background-color:${color}`,
              `background-size:${style.backgroundSize}`,
              `background-position:${style.backgroundPosition}`,
              `background-repeat:${style.backgroundRepeat}`,
              `background-origin:${style.backgroundOrigin}`,
              `background-clip:${style.backgroundClip}`,
              `font-family:${style.fontFamily}`,
              `font-size:${style.fontSize}`,
              `font-weight:${style.fontWeight}`,
              `font-style:${style.fontStyle}`,
              `line-height:${style.lineHeight}`,
              `letter-spacing:${style.letterSpacing}`,
              `text-align:${style.textAlign}`,
              `text-transform:${style.textTransform}`,
              `color:${style.color}`,
              `white-space:${style.whiteSpace}`,
              `opacity:${style.opacity}`,
              'pointer-events:none',
              style.zIndex === 'auto' ? '' : `z-index:${style.zIndex}`
            ].join(';')
            if (text) overlay.textContent = text
            styleRecords.set(overlay, styleRecord(overlay.style))
            if (pseudo === '::before') target.prepend(overlay)
            else target.append(overlay)
          }
        }

        for (let index = 0; index < sourceElements.length; index++) {
          const source = sourceElements[index]
          const target = targetElements[index] as HTMLElement
          if (source instanceof HTMLImageElement && target instanceof HTMLImageElement) {
            const rect = source.getBoundingClientRect()
            // Tracking pixels and display-none images carry no design content.
            if (rect.width < 2 || rect.height < 2) continue
            stats.images++
            const sourceURL = source.currentSrc || source.src
            target.removeAttribute('srcset')
            target.removeAttribute('sizes')
            target.removeAttribute('loading')
            target.removeAttribute('crossorigin')
            if (sourceURL) {
              const svg =
                sourceURL.split('?')[0]?.toLowerCase().endsWith('.svg') ||
                sourceURL.startsWith('data:image/svg')
              const sourceData = svg ? await toDataURL(sourceURL) : ''
              let data = svg
                ? ((await rasterizeSVGData(sourceData, rect.width, rect.height)) ?? sourceData)
                : await toDataURL(sourceURL)
              const filter = getComputedStyle(source).filter
              let filtered = false
              if (filter && filter !== 'none' && !filter.includes('url(')) {
                const baked = await filteredImage(data, filter, rect.width, rect.height)
                if (baked) {
                  data = baked
                  filtered = true
                  target.style.filter = 'none'
                }
              }
              target.src = data
              // A baked filter changes the pixels, so the vector must not replace them again.
              if (svg && !filtered) {
                const index = recordSVG({
                  ...(sourceData.startsWith('data:')
                    ? { data: sourceData }
                    : { source: sourceURL }),
                  ...svgPageRect(source),
                  name: svgName(source, svgFileName(sourceURL) || 'SVG')
                })
                if (index !== null) target.setAttribute(svgAttribute, String(index))
              }
              if (data.startsWith('data:')) stats.imagesInlined++
              if (svg && data.startsWith('data:image/png')) stats.svgs++
            }
          }
          const background =
            source instanceof HTMLElement ? getComputedStyle(source).backgroundImage : ''
          if (background && background !== 'none' && background.includes('url(')) {
            target.style.backgroundImage = await inlineURLs(background)
          }
          if (source instanceof HTMLInputElement && target instanceof HTMLInputElement) {
            if (source.type === 'checkbox' || source.type === 'radio') {
              target.toggleAttribute('checked', source.checked)
            } else if (source.type !== 'file') {
              target.setAttribute('value', source.value)
            }
          }
          if (source instanceof HTMLTextAreaElement && target instanceof HTMLTextAreaElement) {
            target.textContent = source.value
          }
          if (source instanceof HTMLSelectElement && target instanceof HTMLSelectElement) {
            const count = Math.min(source.options.length, target.options.length)
            for (let option = 0; option < count; option++) {
              target.options[option].selected = source.options[option].selected
            }
          }
        }

        const sourceVideos = sourceElements.filter(
          (element): element is HTMLVideoElement => element instanceof HTMLVideoElement
        )
        const cloneVideos = targetElements.filter(
          (element): element is HTMLVideoElement => element instanceof HTMLVideoElement
        )
        for (let index = 0; index < sourceVideos.length; index++) {
          const source = sourceVideos[index]
          const target = cloneVideos[index] as HTMLElement | undefined
          if (!target) continue
          stats.videos++
          const poster = source.poster || source.getAttribute('poster') || ''
          if (!poster) continue
          const data = await toDataURL(poster)
          if (!data.startsWith('data:')) continue
          const image = document.createElement('img')
          image.src = data
          image.style.cssText = target.style.cssText
          target.replaceWith(image)
          stats.imagesInlined++
        }

        const sourceSvgs = sourceElements.filter(
          (element): element is SVGSVGElement => element instanceof SVGSVGElement
        )
        const cloneSvgs = targetElements.filter(
          (element): element is SVGSVGElement => element instanceof SVGSVGElement
        )
        for (const source of sourceSvgs) {
          const target = cloneSvgs.shift()
          if (!target) continue
          const rect = source.getBoundingClientRect()
          if (rect.width < 1 || rect.height < 1) continue
          const markup = new XMLSerializer().serializeToString(target)
          const data = await rasterizeSVGData(
            `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`,
            rect.width,
            rect.height
          )
          if (!data) continue
          const image = document.createElement('img')
          image.src = data
          image.style.cssText = target.style.cssText
          const index = recordSVG({
            svg: markup,
            ...svgPageRect(source),
            name: svgName(source, 'SVG')
          })
          if (index !== null) image.setAttribute(svgAttribute, String(index))
          target.replaceWith(image)
          stats.svgs++
          stats.imagesInlined++
        }

        // Pair the canvases in rendered order, as the video and SVG loops do; the clone's shadow
        // roots are flattened, so querying each tree separately pairs the wrong elements.
        const sourceCanvases = sourceElements.filter(
          (element): element is HTMLCanvasElement => element instanceof HTMLCanvasElement
        )
        const cloneCanvases = targetElements.filter(
          (element): element is HTMLCanvasElement => element instanceof HTMLCanvasElement
        )
        for (let index = 0; index < sourceCanvases.length; index++) {
          const source = sourceCanvases[index]
          const target = cloneCanvases[index] as HTMLElement | undefined
          if (!target) continue
          const rect = source.getBoundingClientRect()
          if (rect.width < 2 || rect.height < 2) continue
          stats.canvases++
          try {
            // A WebGL canvas without preserveDrawingBuffer may read back blank; the layer and
            // its box still stay, and a later state pass can replace it with a screenshot.
            const data = source.toDataURL('image/png')
            if (!data.startsWith('data:image/')) continue
            const image = document.createElement('img')
            image.src = data
            image.style.cssText = target.style.cssText
            target.replaceWith(image)
            stats.imagesInlined++
          } catch {
            console.warn('Canvas could not be read back:', source.className)
          }
        }

        const fontFaces: string[] = []
        const stylesheets: string[] = []
        for (const sheet of document.styleSheets) {
          try {
            for (const rule of sheet.cssRules) {
              if (rule instanceof CSSFontFaceRule) {
                let text = rule.cssText
                text = await inlineURLs(text)
                fontFaces.push(text)
                stats.fontFaces++
              }
            }
          } catch {
            // A cross-origin stylesheet stays a link below.
            continue
          }
        }
        for (const style of document.querySelectorAll('style')) {
          if (style.textContent) stylesheets.push(style.textContent)
        }
        const links = [
          ...document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]')
        ]
          .map(
            (link) => `<link rel="stylesheet" href="${new URL(link.href, document.baseURI).href}">`
          )
          .join('\n')

        const layoutByTarget = new Map<Element, DesignLayout>()
        const untransformed = document.createElement('style')
        untransformed.textContent =
          '*,*::before,*::after{transform:none!important;translate:none!important;' +
          'rotate:none!important;scale:none!important;transition:none!important;' +
          'animation:none!important}'
        document.head.append(untransformed)
        try {
          const origin = root.getBoundingClientRect()
          for (let index = 0; index < sourceElements.length; index++) {
            layoutByTarget.set(
              targetElements[index] as Element,
              measureElement(sourceElements[index], origin)
            )
          }
        } finally {
          untransformed.remove()
        }

        clone
          .querySelectorAll('script,link,style,noscript,template,meta,base')
          .forEach((element) => element.remove())

        const head = [
          '<meta charset="utf-8">',
          `<base href="${document.baseURI}">`,
          '<style>html,body{margin:0;padding:0}*{animation:none!important;transition:none!important}</style>',
          ...stylesheets.map((css) => `<style>${css}</style>`),
          fontFaces.length > 0 ? `<style>${fontFaces.join('\n')}</style>` : '',
          links
        ].join('\n')
        // A body clone is already the body: emitting it inside another body nests one document
        // inside another and the importer sees no page children.
        const bodyStyle = root === document.body ? (clone.getAttribute('style') ?? '') : ''
        const content = root === document.body ? clone.innerHTML : clone.outerHTML
        const pageBackground = [
          getComputedStyle(document.body).backgroundColor,
          getComputedStyle(document.documentElement).backgroundColor
        ].find(
          (color) => color && color !== 'transparent' && !/^rgba?\(0,\s*0,\s*0,\s*0\)$/i.test(color)
        )

        /** The composed tree with resolved styles and boxes, without a second HTML parse. */
        function toDesignNode(node: Node): DesignNode | null {
          if (node.nodeType === Node.TEXT_NODE) {
            const text = node.nodeValue ?? ''
            return text.length > 0 ? { type: 'text', text } : null
          }
          if (node.nodeType !== Node.ELEMENT_NODE) return null
          const element = node as Element
          const attrs: Record<string, string> = {}
          for (const attr of Array.from(element.attributes)) {
            if (attr.name === 'class' || attr.name === 'style') continue
            attrs[attr.name] = attr.value
          }
          const source = sourceByTarget.get(element)
          if (source instanceof HTMLInputElement) {
            attrs.value = source.value
            if (source.checked) attrs.checked = ''
          } else if (source instanceof HTMLTextAreaElement) {
            attrs.value = source.value
          }
          return {
            type: 'element',
            tagName: element.tagName.toLowerCase(),
            attrs,
            children: Array.from(element.childNodes)
              .map(toDesignNode)
              .filter((child): child is DesignNode => child !== null),
            computedStyle: styleRecords.get(element),
            layout: layoutByTarget.get(element)
          }
        }
        const documentModel: DesignDocument = {
          type: 'document',
          children: Array.from(clone.childNodes)
            .map(toDesignNode)
            .filter((node): node is DesignNode => node !== null)
        }

        return {
          html: `<!doctype html><html><head>${head}</head><body style="${bodyStyle}">${content}</body></html>`,
          document: documentModel,
          pageBackground,
          stats: { ...stats, stylesheets: stylesheets.length + (links ? 1 : 0) },
          svgs: capturedSVGs
        }
      },
      { selector: args.selector, svgAttribute: WEB_SVG_ATTRIBUTE }
    )

    report('inlining stylesheets')
    const linked = await inlineLinkedStylesheets(context, captured.html)
    report('inlining fonts and SVGs')
    const [fonts, resolved] = await Promise.all([
      inlineFontSources(context, linked, args.url),
      resolveCapturedSVGs(context, captured.svgs, args.url)
    ])
    report('inlining images')
    const remote = await inlineRemoteImages(context, fonts)
    if (captured.document) {
      applyCapturedAssetReplacements(captured.document, remote.replacements, resolved.remap)
    }
    const html =
      resolved.remap.size === captured.svgs.length
        ? remote.html
        : remapSVGMarkers(remote.html, resolved.remap)
    report('done')
    return {
      html,
      document: captured.document,
      pageBackground: captured.pageBackground,
      reference,
      svgs: resolved.svgs.length > 0 ? resolved.svgs : undefined,
      stats: {
        elements: (html.match(/<[a-z][^>]*>/gi) ?? []).length,
        images: captured.stats.images,
        imagesInlined: captured.stats.imagesInlined + remote.inlined,
        fontFaces: captured.stats.fontFaces,
        stylesheets: captured.stats.stylesheets,
        videos: captured.stats.videos,
        svgs: captured.stats.svgs,
        canvases: captured.stats.canvases,
        bytes: Buffer.byteLength(html)
      }
    }
  } finally {
    await context?.close().catch(() => undefined)
    await browser?.close().catch(() => undefined)
  }
}
