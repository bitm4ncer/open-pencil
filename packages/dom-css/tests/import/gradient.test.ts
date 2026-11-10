import { describe, expect, it } from 'bun:test'

import { gradientFillFromCSS } from '#dom-css/import/gradient'

function expectLinear(value: string | undefined) {
  const fill = gradientFillFromCSS(value, 400, 200)
  expect(fill?.type).toBe('GRADIENT_LINEAR')
  if (!fill || fill.type !== 'GRADIENT_LINEAR') throw new Error('Expected a linear gradient')
  return fill
}

describe('CSS gradient import', () => {
  it('maps a linear gradient and its angle onto a fill', () => {
    const fill = expectLinear('linear-gradient(90deg, #5c50d9 0%, #d50c2d 100%)')

    expect(fill.gradientStops).toHaveLength(2)
    expect(fill.gradientStops?.[0]?.position).toBe(0)
    expect(fill.gradientStops?.[0]?.color.r).toBeCloseTo(0.361, 2)
    expect(fill.gradientStops?.[0]?.color.g).toBeCloseTo(0.314, 2)
    expect(fill.gradientStops?.[0]?.color.b).toBeCloseTo(0.851, 2)
    expect(fill.gradientStops?.[1]?.position).toBe(1)
    expect(fill.gradientStops?.[1]?.color.r).toBeCloseTo(0.835, 2)
    expect(fill.gradientTransform).toBeDefined()
  })

  it('maps a radial gradient with a circle centre', () => {
    const fill = gradientFillFromCSS(
      'radial-gradient(circle at 50% 50%, rgb(255, 255, 255), rgb(0, 0, 0))',
      400,
      200
    )

    expect(fill?.type).toBe('GRADIENT_RADIAL')
    expect(fill?.gradientStops).toHaveLength(2)
    expect(fill?.gradientTransform).toBeDefined()
  })

  it('fills omitted stop positions evenly', () => {
    const fill = expectLinear('linear-gradient(to right, red, green, blue)')

    expect(fill.gradientStops?.map((stop) => stop.position)).toEqual([0, 0.5, 1])
  })

  it('ignores a background that has no gradient', () => {
    expect(gradientFillFromCSS('url("data:image/png;base64,AAAA")', 400, 200)).toBeNull()
    expect(gradientFillFromCSS(undefined, 400, 200)).toBeNull()
  })
})
