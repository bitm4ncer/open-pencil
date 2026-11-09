import type { Hono } from 'hono'
import * as v from 'valibot'

const requestSchema = v.object({
  url: v.pipe(v.string(), v.url(), v.regex(/^https?:\/\//i))
})

const LOC_PATTERN = /<loc>\s*([^<]+?)\s*<\/loc>/gi
const SITEMAP_LINE = /^\s*sitemap:\s*(\S+)\s*$/gim
const HREF_PATTERN = /<a\b[^>]*\bhref=["']([^"']+)["']/gi
const MAX_PAGES = 500
const MAX_SITEMAPS = 8

/** The `<loc>` URLs of a sitemap document, XML entities decoded. */
export function parseSitemapLocs(xml: string): string[] {
  const locs: string[] = []
  for (const match of xml.matchAll(LOC_PATTERN)) {
    const value = match[1]?.trim()
    if (value) locs.push(decodeXMLEntities(value))
  }
  return locs
}

function decodeXMLEntities(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
}

function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml)
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    return response.ok ? await response.text() : null
  } catch {
    return null
  }
}

async function sitemapUrls(origin: string): Promise<string[]> {
  const found = new Set<string>()
  const robots = await fetchText(new URL('/robots.txt', origin).href)
  if (robots) {
    for (const match of robots.matchAll(SITEMAP_LINE)) {
      const url = match[1]
      const same = url ? sameOrigin(url, origin) : null
      if (same) found.add(same)
    }
  }
  if (found.size === 0) {
    for (const path of ['/sitemap.xml', '/sitemap_index.xml']) {
      const candidate = new URL(path, origin).href
      if (await fetchText(candidate)) found.add(candidate)
    }
  }
  return [...found].slice(0, MAX_SITEMAPS)
}

async function collectSitemap(
  url: string,
  origin: string,
  pages: Set<string>,
  seen: Set<string>,
  depth = 0
): Promise<void> {
  if (depth > 2 || seen.size >= MAX_SITEMAPS || seen.has(url)) return
  seen.add(url)
  const xml = await fetchText(url)
  if (!xml) return
  const locs = parseSitemapLocs(xml)
  if (isSitemapIndex(xml)) {
    for (const loc of locs) {
      const child = sameOrigin(loc, origin)
      if (child) await collectSitemap(child, origin, pages, seen, depth + 1)
    }
    return
  }
  for (const loc of locs) {
    const parsed = sameOrigin(loc, origin)
    if (parsed) pages.add(parsed)
    if (pages.size >= MAX_PAGES) return
  }
}

function sameOrigin(value: string, origin: string): string | null {
  try {
    const url = new URL(value, origin)
    if (url.origin !== origin) return null
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.href
  } catch {
    return null
  }
}

function linksInHTML(html: string, origin: string): string[] {
  const links: string[] = []
  for (const match of html.matchAll(HREF_PATTERN)) {
    const href = match[1]
    if (!href || href.startsWith('#') || href.startsWith('mailto:')) continue
    const url = sameOrigin(href, origin)
    if (url) links.push(url)
  }
  return links
}

/** The same-origin pages a site declares in its sitemap, or links from its home page. */
export async function discoverSitePages(url: string): Promise<string[]> {
  const origin = new URL(url).origin
  const pages = new Set<string>()
  const seen = new Set<string>()
  for (const sitemap of await sitemapUrls(origin)) {
    await collectSitemap(sitemap, origin, pages, seen)
    if (pages.size >= MAX_PAGES) break
  }
  if (pages.size === 0) {
    const html = await fetchText(url)
    if (html) for (const link of linksInHTML(html, origin)) pages.add(link)
  }
  return [...pages].slice(0, MAX_PAGES)
}

export function registerSitemapRoutes(app: Hono): void {
  app.post('/sitemap', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid sitemap request' }, 400)
    }
    const parsed = v.safeParse(requestSchema, body)
    if (!parsed.success) return c.json({ error: v.summarize(parsed.issues) }, 400)
    try {
      return c.json({ pages: await discoverSitePages(parsed.output.url) })
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })
}
