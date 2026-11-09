import { expect, test } from 'bun:test'

import { capturedPageColor } from '#core/io/formats/html/layers'

test('keeps the solid background the browser computed', () => {
  expect(capturedPageColor('rgb(255, 0, 0)')).toMatchObject({ r: 1, g: 0, b: 0, a: 1 })
})

test('leaves the page alone when the captured value is not a color', () => {
  expect(capturedPageColor('not-a-color')).toBeNull()
  expect(capturedPageColor('transparent')).toBeNull()
})
