import { expect, test } from 'bun:test'

import {
  DEFAULT_WEB_IMPORT_BREAKPOINT,
  WEB_IMPORT_BREAKPOINTS,
  webImportBreakpoint
} from '@/app/editor/web-import/breakpoints'

test('offers common desktop and mobile breakpoints', () => {
  expect(WEB_IMPORT_BREAKPOINTS.map((breakpoint) => breakpoint.short)).toEqual([
    '4K',
    '1440',
    '1080p',
    'Laptop',
    'Tablet',
    'Mobile'
  ])
  expect(WEB_IMPORT_BREAKPOINTS.find((breakpoint) => breakpoint.id === 'mobile')).toMatchObject({
    width: 390,
    height: 844
  })
})

test('starts at 1440 and falls back to it for an unknown breakpoint', () => {
  expect(webImportBreakpoint(DEFAULT_WEB_IMPORT_BREAKPOINT)).toMatchObject({
    width: 1440,
    height: 900
  })
  expect(webImportBreakpoint('desktop')).toMatchObject({ width: 1440, height: 900 })
})
