import { isValid, toUint8Array } from 'js-base64'

import { resolveEditorProfile, type Editor, type EditorState } from '@open-pencil/core'
import {
  HTML_IMPORT_VIEWPORT,
  sceneGraphFromStyledHTML
} from '@open-pencil/core/io/formats/html/layers'
import { faceStyleName, fontManager, sfntFont } from '@open-pencil/core/text'
import { browserHTMLToDesignDocument, parseFontFaceRules } from '@open-pencil/dom-css/browser'
import { nextFrame } from '@open-pencil/vue/shared/frame'

import { describeDiagnosticError, recordDocumentFailure } from '@/app/diagnostics'
import { applyImportedDocument } from '@/app/document/io/imported-document'
import type { EditorPreparationController } from '@/app/editor/preparation/controller'
import type { EditorPreparationHandle } from '@/app/editor/preparation/types'
import { notificationMessages } from '@/app/i18n/notifications'
import { toast } from '@/app/shell/ui'

type OpenDOMDocumentState = EditorState & {
  documentName: string
  /** Whether the side panels show, which a document opens with as its kind starts it. */
  showUI: boolean
}

type OpenDOMFileOptions = {
  editor: Editor
  state: OpenDOMDocumentState
  setDocumentSource: (
    fileName: string,
    sourceFormat: string,
    handle?: FileSystemFileHandle,
    path?: string
  ) => void
  fitCurrentPageToViewport: (signal?: AbortSignal) => Promise<void>
  preparationController: EditorPreparationController
}

type DOMImportOptions = {
  cssText?: string
  handle?: FileSystemFileHandle
  path?: string
  preparation?: EditorPreparationHandle
}

type DOMTextImportOptions = {
  cssText?: string
  documentName?: string
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function documentNameFor(file: File): string {
  return file.name.replace(/\.(html?|xhtml)$/i, '')
}

function dataURLBytes(url: string): ArrayBuffer | null {
  const comma = url.indexOf(',')
  if (comma === -1) return null
  if (!url.slice(5, comma).toLowerCase().includes(';base64')) return null
  const payload = url.slice(comma + 1)
  if (!isValid(payload)) return null
  const bytes = toUint8Array(payload)
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

async function fontData(url: string): Promise<ArrayBuffer | null> {
  if (url.startsWith('data:')) return dataURLBytes(url)
  try {
    const response = await fetch(url, { credentials: 'include' })
    return response.ok ? await response.arrayBuffer() : null
  } catch (error) {
    console.warn('Font request failed:', url, error)
    return null
  }
}

/**
 * Registers the page's `@font-face` files with the font manager, so the imported text draws in
 * them and they join the font library. A font that fails to load is left to the fallback chain.
 */
async function registerPageFonts(html: string, cssText?: string): Promise<void> {
  const document = new DOMParser().parseFromString(html, 'text/html')
  const base = document.querySelector('base')?.getAttribute('href') ?? document.baseURI
  const styles = [...document.querySelectorAll('style')].map((style) => style.textContent)
  if (cssText) styles.push(cssText)
  const links = [
    ...document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]')
  ].map((link) => link.href)
  const linked = await Promise.allSettled(
    links.map(async (href) => {
      const response = await fetch(href, { credentials: 'include' })
      return response.ok ? response.text() : ''
    })
  )
  for (const result of linked)
    if (result.status === 'fulfilled' && result.value) styles.push(result.value)
  const rules = styles.flatMap((css) => parseFontFaceRules(css, base))
  await Promise.allSettled(
    rules.map(async (rule) => {
      const style = faceStyleName(rule.family, rule.weight, rule.italic)
      if (fontManager.isStyleLoaded(rule.family, style)) return
      for (const source of rule.sources) {
        const data = await fontData(source)
        if (!data) continue
        try {
          await fontManager.markLoaded(rule.family, style, await sfntFont(data))
          return
        } catch (error) {
          console.warn('Font registration failed:', rule.family, source, error)
        }
      }
    })
  )
}

export function createDOMOpenActions({
  editor,
  state,
  setDocumentSource,
  fitCurrentPageToViewport,
  preparationController
}: OpenDOMFileOptions) {
  async function applyDOMText(
    html: string,
    options: DOMTextImportOptions,
    load: ReturnType<EditorPreparationController['begin']>
  ) {
    await nextFrame()
    const pageName = options.documentName ?? 'DOM Import'
    load.update({ phase: 'decoding', detail: pageName })
    await registerPageFonts(html, options.cssText)
    load.signal.throwIfAborted()
    // Laid out as a browser would, so layers land where the page put its elements.
    const styled = await browserHTMLToDesignDocument(html, {
      cssText: options.cssText,
      signal: load.signal,
      compute: { layout: true, viewport: HTML_IMPORT_VIEWPORT }
    })
    load.signal.throwIfAborted()
    const graph = await sceneGraphFromStyledHTML(styled, { pageName })
    await nextFrame()
    await applyImportedDocument(editor, graph, load)
    // Into a reused tab too, the document opens with the panels its kind starts with.
    state.showUI = resolveEditorProfile(editor.state).panelsOpen
    state.documentName = pageName
    // A later open supersedes this one while it waits for a hidden tab to be shown.
    await fitCurrentPageToViewport(load.signal)
    load.signal.throwIfAborted()
    editor.requestRender()
    return pageName
  }

  async function importDOMText(html: string, options: DOMTextImportOptions = {}) {
    const load = preparationController.begin({
      kind: 'dom-import',
      subject: options.documentName ?? 'DOM Import'
    })
    let succeeded = false
    try {
      const pageName = await applyDOMText(html, options, load)
      setDocumentSource(`${pageName}.html`, 'html')
      toast.info(notificationMessages.get().importedDOMCSS)
      succeeded = true
    } catch (e) {
      if (load.signal.aborted) throw e
      const diagnostic = describeDiagnosticError(e)
      load.fail({
        code: 'decode-failed',
        message: errorDetail(e),
        retryable: diagnostic.retryable ?? true
      })
      recordDocumentFailure({
        operation: 'import',
        format: 'dom-css',
        ...diagnostic,
        retryable: diagnostic.retryable
      })
      console.error('Failed to import DOM/CSS:', e)
      toast.error(notificationMessages.get().importDOMCSSFailed({ error: errorDetail(e) }))
      throw e
    } finally {
      if (succeeded) load.complete()
    }
  }

  async function openDOMFile(file: File, options: DOMImportOptions = {}) {
    const load =
      options.preparation ?? preparationController.begin({ kind: 'dom-import', subject: file.name })
    const ownsLoad = options.preparation === undefined
    let succeeded = false
    try {
      const html = await file.text()
      await applyDOMText(
        html,
        {
          cssText: options.cssText,
          documentName: documentNameFor(file)
        },
        load
      )
      setDocumentSource(file.name, 'html', options.handle, options.path)
      succeeded = true
    } catch (e) {
      if (load.signal.aborted || !ownsLoad) throw e
      const diagnostic = describeDiagnosticError(e)
      load.fail({
        code: 'decode-failed',
        message: errorDetail(e),
        retryable: diagnostic.retryable ?? true
      })
      recordDocumentFailure({
        operation: 'open',
        format: 'dom-css',
        ...diagnostic,
        retryable: diagnostic.retryable
      })
      console.error('Failed to open DOM/CSS file:', e)
      toast.error(notificationMessages.get().openDOMCSSFailed({ error: errorDetail(e) }))
    } finally {
      if (ownsLoad && succeeded) load.complete()
    }
  }

  return { openDOMFile, importDOMText }
}
