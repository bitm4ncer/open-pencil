import * as v from 'valibot'

import type { DesignDocument, DesignNode } from '@open-pencil/dom-css'

/** An SVG a remote capture kept beside its raster fallback. */
export const capturedSVGSchema = v.object({
  svg: v.string(),
  x: v.number(),
  y: v.number(),
  width: v.pipe(v.number(), v.minValue(0)),
  height: v.pipe(v.number(), v.minValue(0)),
  name: v.optional(v.string())
})

function isDesignNode(value: unknown): value is DesignNode {
  if (!value || typeof value !== 'object') return false
  const node = value as Record<string, unknown>
  if (node.type === 'text') return typeof node.text === 'string'
  if (node.type !== 'element' || typeof node.tagName !== 'string') return false
  if (!Array.isArray(node.children)) return false
  return node.children.every((child) => isDesignNode(child))
}

function isDesignDocument(value: unknown): value is DesignDocument {
  if (!value || typeof value !== 'object') return false
  const document = value as Record<string, unknown>
  return (
    document.type === 'document' &&
    Array.isArray(document.children) &&
    document.children.every((child) => isDesignNode(child))
  )
}

/** The page the capture composed, styled, and measured, for a projection without a second parse. */
export const capturedDocumentSchema = v.custom<DesignDocument>(isDesignDocument)
