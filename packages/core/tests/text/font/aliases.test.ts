import { expect, test } from 'bun:test'

import { fontFamilyAliases } from '#core/text/font/aliases'

test('registers a weight-in-name family under its base family and weight', () => {
  expect(fontFamilyAliases('CircularXXWeb-Bold', 'Regular')).toEqual([
    { family: 'CircularXXWeb-Bold', style: 'Regular' },
    { family: 'CircularXXWeb-Bold', style: 'Bold' },
    { family: 'CircularXXWeb', style: 'Bold' },
    { family: 'CircularXXWeb-Bold', style: 'SemiBold' }
  ])
})

test('registers the regular face under the base family', () => {
  expect(fontFamilyAliases('CircularXXWeb-Regular', 'Regular')).toEqual([
    { family: 'CircularXXWeb-Regular', style: 'Regular' },
    { family: 'CircularXXWeb', style: 'Regular' }
  ])
})

test('reads abbreviated foundry suffixes and leaves ordinary families alone', () => {
  expect(fontFamilyAliases('ImagoBQBolIta', 'Regular')).toContainEqual({
    family: 'ImagoBQ',
    style: 'Bold Italic'
  })
  expect(fontFamilyAliases('infraserv-icons', 'Regular')).toEqual([
    { family: 'infraserv-icons', style: 'Regular' }
  ])
})
