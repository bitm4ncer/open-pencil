import type { Element } from '@xmldom/xmldom'

import type { SVGClipPathRegion, SVGElementLayer, SVGTextInfo } from '#core/icons/types'

import {
  elementStyles,
  opacityValue,
  presentationVisible,
  type PresentationAttributes,
  type SVGStyleRule
} from './presentation'

export interface Traversal {
  root: Element
  elementsById: ReadonlyMap<string, Element>
  /** Colour rules from the SVG's own `<style>` blocks. */
  styleRules: readonly SVGStyleRule[]
  nextKey: number
  /** `<text>` elements in drawing order; each records how many paths precede it. */
  texts: SVGTextInfo[]
}

/** What an element inherits from the elements around it. */
export interface Scope {
  presentation: PresentationAttributes
  transform: string | null
  clipPaths: SVGClipPathRegion[]
  elements: SVGElementLayer[]
  useStack: ReadonlySet<Element>
  /** Drawn through `<use>` or inside a `<clipPath>`, so ids name the source, not this copy. */
  referenced: boolean
  styleRules: readonly SVGStyleRule[]
}

export function elementLayer(
  traversal: Traversal,
  element: Element,
  kind: SVGElementLayer['kind'],
  scope: Pick<Scope, 'presentation' | 'referenced'>,
  clip: number | null
): SVGElementLayer {
  return {
    key: traversal.nextKey++,
    kind,
    name: scope.referenced ? null : element.getAttribute('id') || null,
    opacity: opacityValue(
      elementStyles(element, traversal.styleRules).get('opacity') ?? element.getAttribute('opacity')
    ),
    visible: presentationVisible(scope.presentation),
    clip
  }
}
