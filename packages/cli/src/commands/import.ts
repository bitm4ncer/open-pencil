import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { defineCommand } from 'citty'

import { readHTMLDocument, type ReadHTMLResult } from '@open-pencil/core/io/formats/html/import'

import { requireFile } from '#cli/app/client'
import { fmtList, ok, printError } from '#cli/format'
import { writeFigDocument } from '#cli/headless'
import { captureWebPage } from '#cli/web-import/capture'

const OUTPUT_FORMATS = new Set(['fig', 'json'])

interface ImportArgs {
  file?: string
  url?: string
  selector?: string
  viewport: string
  wait: string
  scroll: boolean
  executable?: string
  output?: string
  format: string
  css?: string
  cssText?: string
  tailwind?: string
  tailwindFile?: string
  pageName: string
  json?: boolean
}

function parseViewport(value: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/i.exec(value.trim())
  if (!match) throw new Error(`Invalid viewport "${value}". Use WIDTHxHEIGHT, such as 1440x900.`)
  return { width: Number(match[1]), height: Number(match[2]) }
}

function inputName(args: ImportArgs): string {
  return args.url ?? requireFile(args.file)
}

function defaultOutput(input: string, format: string): string {
  if (/^https?:\/\//i.test(input)) {
    const host = new URL(input).hostname.replace(/^www\./i, '')
    return resolve(`${host}.${format}`)
  }
  const base = basename(input, extname(input))
  return resolve(`${base}.${format}`)
}

async function readTextFile(path: string): Promise<string> {
  return readFile(requireFile(path), 'utf8')
}

async function cssTextForArgs(args: ImportArgs): Promise<string | undefined> {
  const cssParts = []
  if (args.css) cssParts.push(await readTextFile(args.css))
  if (args.cssText) cssParts.push(args.cssText)
  return cssParts.length > 0 ? cssParts.join('\n') : undefined
}

async function tailwindCandidatesForArgs(args: ImportArgs): Promise<string[] | undefined> {
  const parts = []
  if (args.tailwind) parts.push(args.tailwind)
  if (args.tailwindFile) parts.push(await readTextFile(args.tailwindFile))
  const classes = parts
    .flatMap((part) => part.split(/\s+/))
    .filter((className) => className.length > 0)
  return classes.length > 0 ? classes : undefined
}

async function importHTML(args: ImportArgs): Promise<ReadHTMLResult> {
  const cssText = await cssTextForArgs(args)
  const tailwind = await tailwindCandidatesForArgs(args)
  if (args.url) {
    const captured = await captureWebPage({
      url: args.url,
      selector: args.selector,
      viewport: parseViewport(args.viewport),
      waitMs: Number(args.wait),
      scroll: args.scroll,
      executable: args.executable
    })
    return readHTMLDocument(captured.html, {
      baseURL: args.url,
      cssText,
      tailwind,
      pageName: args.pageName
    })
  }
  const file = requireFile(args.file)
  return readHTMLDocument(await readTextFile(file), {
    // Relative stylesheets, fonts, and images resolve beside the file, as a browser opening it.
    baseURL: pathToFileURL(resolve(file)).href,
    cssText,
    tailwind,
    pageName: args.pageName
  })
}

async function writeOutput(args: ImportArgs, { styled, graph }: ReadHTMLResult) {
  const format = args.format.toLowerCase()
  const output = args.output ? resolve(args.output) : defaultOutput(inputName(args), format)

  await mkdir(dirname(output), { recursive: true })

  if (format === 'json') {
    await writeFile(output, `${JSON.stringify(styled, null, 2)}\n`)
    return output
  }

  await writeFigDocument(graph, output)
  return output
}

export default defineCommand({
  meta: { description: 'Import HTML/CSS/Tailwind into an OpenPencil document' },
  args: {
    file: {
      type: 'positional',
      description: 'Input HTML file path',
      required: false
    },
    url: {
      type: 'string',
      description: 'Capture and import a live page at an http(s) URL (needs Playwright)',
      required: false
    },
    selector: {
      type: 'string',
      description: 'Capture only the subtree matching this CSS selector',
      required: false
    },
    viewport: {
      type: 'string',
      description: 'Capture viewport as WIDTHxHEIGHT (default: 1440x900)',
      default: '1440x900'
    },
    wait: {
      type: 'string',
      description: 'Extra milliseconds to wait before capture (default: 500)',
      default: '500'
    },
    scroll: {
      type: 'boolean',
      description: 'Scroll through the page before capture so lazy content loads'
    },
    executable: {
      type: 'string',
      description: 'Chromium executable path for the capture',
      required: false
    },
    output: {
      type: 'string',
      alias: 'o',
      description: 'Output file path (default: <name>.<format>)',
      required: false
    },
    format: {
      type: 'string',
      alias: 'f',
      description: 'Output format: fig or json (default: fig)',
      default: 'fig'
    },
    css: {
      type: 'string',
      description: 'CSS file to apply before conversion',
      required: false
    },
    cssText: {
      type: 'string',
      description: 'Inline CSS text to apply before conversion',
      required: false
    },
    tailwind: {
      type: 'string',
      description: 'Tailwind utility candidates to compile and apply',
      required: false
    },
    tailwindFile: {
      type: 'string',
      description: 'File containing Tailwind utility candidates',
      required: false
    },
    pageName: {
      type: 'string',
      description: 'Scene graph page name (default: DOM/CSS)',
      default: 'DOM/CSS'
    },
    json: {
      type: 'boolean',
      description: 'Print a machine-readable summary to stdout'
    }
  },
  async run({ args }) {
    const format = args.format.toLowerCase()
    if (!OUTPUT_FORMATS.has(format)) {
      printError(`Invalid format "${args.format}". Use fig or json.`)
      process.exit(1)
    }
    if (args.url && args.file) {
      printError('Pass either an HTML file or --url, not both.')
      process.exit(1)
    }
    if (!args.url && !args.file) {
      printError('Pass an HTML file or --url.')
      process.exit(1)
    }

    const imported = await importHTML(args)
    const output = await writeOutput(args, imported)
    const pages = imported.graph.getPages()
    const summary = {
      input: inputName(args),
      output,
      format,
      pages: pages.length,
      rootElements: imported.styled.children.length
    }

    if (args.json) {
      console.log(JSON.stringify(summary, null, 2))
      return
    }

    console.log(ok(`Converted ${summary.input} → ${summary.output}`))
    console.log(
      fmtList([
        {
          header: 'HTML/CSS import',
          details: summary
        }
      ])
    )
  }
})
