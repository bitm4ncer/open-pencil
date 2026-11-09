import { expect, test, type Page } from '@playwright/test'

import { CanvasHelper } from '#tests/helpers/canvas'

const PAGE_URL = 'https://example.com/'

const CAPTURED_HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0}</style></head>
<body><h1 style="margin:0;font:700 40px sans-serif;color:#111111">Imported heading</h1></body></html>`

/** The same page as the capture's composed model, which skips parsing and laying out the HTML. */
const CAPTURED_DOCUMENT = {
  type: 'document',
  children: [
    {
      type: 'element',
      tagName: 'h1',
      attrs: {},
      computedStyle: {
        display: 'block',
        margin: '0px',
        'font-family': 'sans-serif',
        'font-size': '40px',
        'font-weight': '700',
        color: 'rgb(17, 17, 17)',
        'line-height': 'normal',
        'white-space': 'normal'
      },
      layout: {
        box: { x: 0, y: 0, width: 320, height: 48 },
        lines: [{ x: 0, y: 0, width: 320, height: 48 }]
      },
      children: [{ type: 'text', text: 'Imported heading' }]
    }
  ]
}

/** A one-pixel PNG, enough for the reference layer's image fill to decode. */
const REFERENCE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='

async function openWebImportDialog(page: Page): Promise<void> {
  await page.getByTestId('menubar-file').click()
  await page.getByRole('menuitem', { name: /Import from Web/ }).click()
}

test('imports a page with its reference image from the File menu', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/?test')
  const canvas = new CanvasHelper(page)
  await canvas.waitForInit()

  // The dialog renders pages on the local automation server; the test answers for it.
  await page.route('**/capture', (route) =>
    route.fulfill({
      json: {
        html: CAPTURED_HTML,
        document: CAPTURED_DOCUMENT,
        pageBackground: 'rgb(255, 255, 255)',
        reference: { src: REFERENCE_PNG, width: 320, height: 200 },
        svgs: []
      }
    })
  )

  await openWebImportDialog(page)
  await expect(page.getByTestId('web-import-dialog')).toBeVisible()
  await page.getByTestId('web-import-url').fill(PAGE_URL)
  await page.getByTestId('web-import-submit').click()

  await expect(page.getByTestId('web-import-refine')).toBeVisible({ timeout: 30_000 })

  const imported = await page.evaluate(() => {
    const store = window.openPencil?.getStore?.()
    if (!store) throw new Error('OpenPencil store not initialized')
    const nodes = [...store.graph.getAllNodes()]
    return {
      documentName: store.state.documentName,
      texts: nodes
        .filter((node) => node.type === 'TEXT')
        .map((node) => node.text.trim())
        .filter((text) => text.length > 0),
      imageLayers: nodes.filter(
        (node) => node.type === 'RECTANGLE' && node.fills.some((fill) => fill.type === 'IMAGE')
      ).length,
      pageBackground: store.state.pageColor
    }
  })

  expect(imported.documentName).toContain('example.com')
  expect(imported.texts).toContain('Imported heading')
  expect(imported.imageLayers).toBe(1)
  expect(imported.pageBackground).toMatchObject({ r: 1, g: 1, b: 1, a: 1 })
  canvas.assertNoErrors()
})

test('imports the pages chosen from a site sitemap as frames', async ({ page }) => {
  test.setTimeout(90_000)
  await page.goto('/?test')
  const canvas = new CanvasHelper(page)
  await canvas.waitForInit()

  await page.route('**/sitemap', (route) =>
    route.fulfill({
      json: { pages: ['https://example.com/', 'https://example.com/about'] }
    })
  )
  await page.route('**/capture', (route) =>
    route.fulfill({
      json: {
        html: CAPTURED_HTML,
        pageBackground: 'rgb(255, 255, 255)',
        svgs: []
      }
    })
  )

  await openWebImportDialog(page)
  await page.getByTestId('web-import-url').fill(PAGE_URL)
  await page.getByTestId('web-import-all-pages').check()
  await page.getByTestId('web-import-submit').click()

  await expect(page.getByTestId('web-import-page')).toHaveCount(2)
  await page.getByTestId('web-import-submit').click()

  await expect(page.getByTestId('web-import-refine')).toBeVisible({ timeout: 60_000 })

  const imported = await page.evaluate(() => {
    const store = window.openPencil?.getStore?.()
    if (!store) throw new Error('OpenPencil store not initialized')
    const nodes = [...store.graph.getAllNodes()]
    return {
      frames: store.graph
        .getChildren(store.state.currentPageId)
        .filter((node) => node.type === 'FRAME').length,
      texts: nodes
        .filter((node) => node.type === 'TEXT')
        .map((node) => node.text.trim())
        .filter((text) => text.length > 0)
    }
  })

  expect(imported.frames).toBe(2)
  expect(imported.texts.filter((text) => text === 'Imported heading')).toHaveLength(2)
  canvas.assertNoErrors()
})

test('cancelling a capture leaves the open document untouched', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/?test')
  const canvas = new CanvasHelper(page)
  await canvas.waitForInit()

  await page.route('**/capture', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    await route
      .fulfill({
        json: {
          html: CAPTURED_HTML,
          pageBackground: 'rgb(255, 255, 255)',
          svgs: []
        }
      })
      .catch(() => undefined)
  })

  const before = await page.evaluate(() => window.openPencil?.getStore?.()?.state.documentName)

  await openWebImportDialog(page)
  await page.getByTestId('web-import-url').fill(PAGE_URL)
  await page.getByTestId('web-import-submit').click()
  await page
    .getByTestId('web-import-dialog')
    .getByRole('button', { name: 'Cancel' })
    .click()

  await expect(page.getByTestId('web-import-dialog')).not.toBeVisible()
  await page.waitForTimeout(3_000)
  await expect(page.getByTestId('web-import-refine')).not.toBeVisible()

  const after = await page.evaluate(() => window.openPencil?.getStore?.()?.state.documentName)
  expect(after).toBe(before)
  canvas.assertNoErrors()
})

test('a failed page leaves no half-imported document', async ({ page }) => {
  test.setTimeout(90_000)
  await page.goto('/?test')
  const canvas = new CanvasHelper(page)
  await canvas.waitForInit()

  let captures = 0
  await page.route('**/sitemap', (route) =>
    route.fulfill({
      json: { pages: ['https://example.com/', 'https://example.com/about'] }
    })
  )
  await page.route('**/capture', (route) => {
    captures++
    if (captures === 1) {
      return route.fulfill({
        json: { html: CAPTURED_HTML, pageBackground: 'rgb(255, 255, 255)', svgs: [] }
      })
    }
    return route.fulfill({ status: 500, json: { error: 'Capture failed' } })
  })

  const before = await page.evaluate(() => window.openPencil?.getStore?.()?.state.documentName)

  await openWebImportDialog(page)
  await page.getByTestId('web-import-url').fill(PAGE_URL)
  await page.getByTestId('web-import-all-pages').check()
  await page.getByTestId('web-import-submit').click()
  await expect(page.getByTestId('web-import-page')).toHaveCount(2)
  await page.getByTestId('web-import-submit').click()

  await expect(page.getByTestId('web-import-dialog')).toContainText('Capture failed')
  await expect(page.getByTestId('web-import-refine')).not.toBeVisible()

  const after = await page.evaluate(() => window.openPencil?.getStore?.()?.state.documentName)
  expect(after).toBe(before)
})
