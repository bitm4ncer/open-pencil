import type { Browser, BrowserContext, Page } from '@playwright/test'

export interface CaptureOptions {
  url: string
  selector?: string
  viewport: { width: number; height: number }
  waitMs: number
  scroll: boolean
  executable?: string
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
  stats: {
    elements: number
    images: number
    imagesInlined: number
    fontFaces: number
    stylesheets: number
    bytes: number
  }
}

async function settle(page: Page, waitMs: number) {
  await page.waitForLoadState('domcontentloaded')
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
  await page.evaluate(async () => {
    const timeout = () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 5_000)
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
  await page.evaluate(async () => {
    const step = Math.max(1, window.innerHeight * 0.8)
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y)
      await new Promise((resolve) => {
        setTimeout(resolve, 80)
      })
    }
    window.scrollTo(0, 0)
  })
}

export async function captureWebPage(args: CaptureOptions): Promise<CaptureResult> {
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  try {
    const { chromium } = await loadPlaywright()
    browser = await chromium.launch({
      headless: true,
      executablePath: args.executable
    })
    context = await browser.newContext({
      viewport: args.viewport,
      deviceScaleFactor: 1,
      locale: 'en-US'
    })
    const page = await context.newPage()
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await settle(page, args.waitMs)
    if (args.scroll) {
      await scrollThrough(page)
      await settle(page, args.waitMs)
    }

    const captured = await page.evaluate(
      // oxlint-disable-next-line complexity -- one browser-side walk over the captured DOM
      async ({ selector }) => {
        const root = selector ? document.querySelector(selector) : document.body
        if (!root) throw new Error(`Selector "${selector}" did not match anything.`)

        const sourceElements = [root, ...root.querySelectorAll('*')]
        const clone = root.cloneNode(true) as Element
        const targetElements = [clone, ...clone.querySelectorAll('*')]

        const stats = { images: 0, imagesInlined: 0, fontFaces: 0, stylesheets: 0 }

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

        for (let index = 0; index < sourceElements.length; index++) {
          const source = sourceElements[index]
          const target = targetElements[index] as HTMLElement
          const computed = getComputedStyle(source)
          let css = ''
          for (const property of computed) {
            const value = computed.getPropertyValue(property)
            if (value) css += `${property}:${value};`
          }
          target.style.cssText = css
          target.removeAttribute('class')
          target.removeAttribute('id')
        }

        for (let index = 0; index < sourceElements.length; index++) {
          const source = sourceElements[index]
          const target = targetElements[index] as HTMLElement
          if (source instanceof HTMLImageElement && target instanceof HTMLImageElement) {
            stats.images++
            const sourceURL = source.currentSrc || source.src
            target.removeAttribute('srcset')
            target.removeAttribute('sizes')
            target.removeAttribute('loading')
            target.removeAttribute('crossorigin')
            if (sourceURL) {
              const data = await toDataURL(sourceURL)
              target.src = data
              if (data.startsWith('data:')) stats.imagesInlined++
            }
          }
          const background =
            source instanceof HTMLElement ? getComputedStyle(source).backgroundImage : ''
          if (background && background !== 'none' && background.includes('url(')) {
            target.style.backgroundImage = await inlineURLs(background)
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
        return {
          html: `<!doctype html><html><head>${head}</head><body style="${bodyStyle}">${content}</body></html>`,
          stats: { ...stats, stylesheets: stylesheets.length + (links ? 1 : 0) }
        }
      },
      { selector: args.selector }
    )

    return {
      html: captured.html,
      stats: {
        elements: (captured.html.match(/<[a-z][^>]*>/gi) ?? []).length,
        images: captured.stats.images,
        imagesInlined: captured.stats.imagesInlined,
        fontFaces: captured.stats.fontFaces,
        stylesheets: captured.stats.stylesheets,
        bytes: Buffer.byteLength(captured.html)
      }
    }
  } finally {
    await context?.close().catch(() => undefined)
    await browser?.close().catch(() => undefined)
  }
}
