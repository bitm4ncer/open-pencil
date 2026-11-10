import valueParser from 'postcss-value-parser'

import type { Fill } from '@open-pencil/scene-graph'
import { tryParseColor } from '@open-pencil/scene-graph/color'
import { TRANSPARENT } from '@open-pencil/scene-graph/constants'
import {
  ellipticalGradientTransform,
  linearGradientTransform
} from '@open-pencil/scene-graph/gradient'

type ValueNode = ReturnType<typeof valueParser>['nodes'][number]
type GradientStop = { color: NonNullable<ReturnType<typeof tryParseColor>>; position: number | null }

function groups(nodes: ValueNode[]): string[] {
  const result: string[] = []
  let current: ValueNode[] = []
  for (const node of nodes) {
    if (node.type === 'div' && node.value === ',') {
      result.push(valueParser.stringify(current).trim())
      current = []
    } else {
      current.push(node)
    }
  }
  result.push(valueParser.stringify(current).trim())
  return result
}

function angleInDegrees(value: string): number | null {
  const match = /^(-?\d*\.?\d+)(deg|grad|rad|turn)?$/i.exec(value.trim())
  if (!match) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return null
  switch ((match[2] ?? 'deg').toLowerCase()) {
    case 'deg':
      return amount
    case 'grad':
      return amount * 0.9
    case 'rad':
      return (amount * 180) / Math.PI
    case 'turn':
      return amount * 360
    default:
      return null
  }
}

/** The CSS angle of a linear gradient's first argument, or null when it is a colour stop. */
function linearDirection(value: string): number | null {
  const text = value.trim().toLowerCase()
  const named: Record<string, number> = {
    'to top': 0,
    'to top right': 45,
    'to right top': 45,
    'to right': 90,
    'to bottom right': 135,
    'to right bottom': 135,
    'to bottom': 180,
    'to bottom left': 225,
    'to left bottom': 225,
    'to left': 270,
    'to top left': 315,
    'to left top': 315
  }
  if (text in named) return named[text]
  if (text.startsWith('to ')) {
    const sides = text.slice(3).split(/\s+/)
    if (sides.length === 2) {
      const vertical = sides.includes('top') ? 'top' : sides.includes('bottom') ? 'bottom' : null
      const horizontal = sides.includes('left') ? 'left' : sides.includes('right') ? 'right' : null
      if (vertical && horizontal) return named[`to ${vertical} ${horizontal}`] ?? null
    }
  }
  return angleInDegrees(text)
}

function positionValue(value: string, lineLength: number): number | null {
  const match = /^(-?\d*\.?\d+)(%|px)?$/i.exec(value.trim())
  if (!match) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return null
  if (match[2] === '%') return amount / 100
  if (match[2] === 'px') return lineLength > 0 ? amount / lineLength : null
  return null
}

function colorAtStart(value: string): { color: NonNullable<ReturnType<typeof tryParseColor>>; rest: string } | null {
  const match = /^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-z]+)\s*(.*)$/i.exec(value.trim())
  if (!match) return null
  const color = tryParseColor(match[1])
  if (!color) return null
  return { color, rest: match[2]?.trim() ?? '' }
}

function parseStops(values: string[], lineLength: number): GradientStop[] {
  const stops: GradientStop[] = []
  for (const value of values) {
    const parsed = colorAtStart(value)
    if (!parsed) continue
    const firstPosition = parsed.rest.split(/\s+/)[0]
    const position = firstPosition ? positionValue(firstPosition, lineLength) : null
    stops.push({ color: parsed.color, position })
  }
  return stops
}

/** Fills omitted stop positions the way CSS does: between the nearest known neighbours. */
function resolvedStops(stops: GradientStop[]): Array<{ color: GradientStop['color']; position: number }> {
  if (stops.length === 0) return []
  const first = stops[0]
  const last = stops[stops.length - 1]
  if (first.position === null) first.position = 0
  if (last.position === null) last.position = 1
  let previous = 0
  for (let index = 1; index < stops.length; index++) {
    if (stops[index].position === null) continue
    const from = stops[previous].position ?? 0
    const to = stops[index].position ?? 1
    const gap = index - previous
    for (let offset = 1; offset < gap; offset++) {
      stops[previous + offset].position = from + ((to - from) * offset) / gap
    }
    previous = index
  }
  return stops.map((stop) => ({
    color: stop.color,
    position: Math.min(1, Math.max(0, stop.position ?? 0))
  }))
}

/**
 * The first CSS gradient of `background-image` as a scene-graph fill, or null. Sizes are the
 * element's box; the caller maps a captured CSS box onto a layer, so the gradient lines up with
 * the pixels the page drew.
 */
export function gradientFillFromCSS(
  value: string | undefined,
  width: number,
  height: number
): Fill | null {
  if (!value) return null
  const parsed = valueParser(value)
  const fn = parsed.nodes.find(
    (node) =>
      node.type === 'function' &&
      (node.value.toLowerCase() === 'linear-gradient' ||
        node.value.toLowerCase() === 'radial-gradient')
  )
  if (!fn || fn.type !== 'function') return null

  const args = groups(fn.nodes)
  if (args.length < 2) return null
  const isLinear = fn.value.toLowerCase() === 'linear-gradient'
  const direction = isLinear ? linearDirection(args[0]) : null
  const stopArgs = direction === null ? args : args.slice(1)
  if (!isLinear) {
    // A leading shape or position (`circle at 50% 50%`) is not a colour stop.
    if (stopArgs[0] && !colorAtStart(stopArgs[0])) stopArgs.shift()
  }
  if (stopArgs.length < 2) return null

  if (!isLinear) {
    const stops = resolvedStops(parseStops(stopArgs, Math.max(width, height)))
    if (stops.length < 2) return null
    return {
      type: 'GRADIENT_RADIAL',
      gradientStops: stops,
      gradientTransform: ellipticalGradientTransform(
        { x: 0.5, y: 0.5 },
        { x: 1, y: 0.5 },
        { x: 0.5, y: 1 }
      ),
      color: TRANSPARENT,
      opacity: 1,
      visible: true
    }
  }

  const radians = ((direction ?? 180) * Math.PI) / 180
  const directionVector = { x: Math.sin(radians), y: -Math.cos(radians) }
  const lineLength =
    Math.abs(width * directionVector.x) + Math.abs(height * directionVector.y) || Math.max(width, height)
  const stops = resolvedStops(parseStops(stopArgs, lineLength))
  if (stops.length < 2) return null

  const half = {
    x: (directionVector.x * lineLength) / 2 / (width || 1),
    y: (directionVector.y * lineLength) / 2 / (height || 1)
  }
  const start = { x: 0.5 - half.x, y: 0.5 - half.y }
  const end = { x: 0.5 + half.x, y: 0.5 + half.y }
  return {
    type: 'GRADIENT_LINEAR',
    gradientStops: stops,
    gradientTransform: linearGradientTransform(start, end, 1, 1, 1),
    color: TRANSPARENT,
    opacity: 1,
    visible: true
  }
}
