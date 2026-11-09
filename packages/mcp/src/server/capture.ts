import type { Hono, MiddlewareHandler } from 'hono'
import * as v from 'valibot'

import { captureWebPage } from '@open-pencil/core/node/web-capture'

import { registerSitemapRoutes } from './sitemap'

const viewportSchema = v.object({
  width: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10_000)),
  height: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10_000))
})

const captureRequestSchema = v.object({
  url: v.pipe(v.string(), v.url()),
  selector: v.optional(v.pipe(v.string(), v.maxLength(2_000))),
  viewport: v.optional(viewportSchema),
  wait: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(60_000))),
  scroll: v.optional(v.boolean()),
  reference: v.optional(v.boolean()),
  executable: v.optional(v.pipe(v.string(), v.maxLength(4_000)))
})

/**
 * Captures a live page for the app or an agent. The browser cannot read another origin's DOM, so
 * the local MCP server, which has Node, renders it with Playwright and returns the inlined HTML.
 */
export function registerCaptureRoutes(app: Hono, requireToken: MiddlewareHandler): void {
  app.use('/capture', requireToken)
  app.use('/sitemap', requireToken)
  registerSitemapRoutes(app)
  app.post('/capture', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid capture request' }, 400)
    }
    const parsed = v.safeParse(captureRequestSchema, body)
    if (!parsed.success) {
      return c.json({ error: v.summarize(parsed.issues) }, 400)
    }
    try {
      const result = await captureWebPage({
        url: parsed.output.url,
        selector: parsed.output.selector,
        viewport: parsed.output.viewport ?? { width: 1440, height: 900 },
        waitMs: parsed.output.wait ?? 500,
        scroll: parsed.output.scroll ?? false,
        reference: parsed.output.reference ?? false,
        executable: parsed.output.executable
      })
      return c.json(result)
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })
}
