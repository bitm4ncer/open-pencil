import { expect, test } from 'bun:test'

import {
  CONSENT_ACCEPT_CONTROL,
  CONSENT_REJECT_CONTROL,
  OVERLAY_DISMISS_LABELS
} from '#core/node/web-capture'

test('overlay labels are readable text rather than mis-decoded bytes', () => {
  expect(OVERLAY_DISMISS_LABELS.length).toBeGreaterThan(0)
  for (const label of OVERLAY_DISMISS_LABELS) {
    expect(label).not.toMatch(/[\uFFFDÃÂ]/)
  }
})

test('a consent banner offers a control in either direction', () => {
  expect(CONSENT_REJECT_CONTROL.test('Notwendige Cookies erlauben')).toBe(true)
  expect(CONSENT_REJECT_CONTROL.test('Reject all')).toBe(true)
  expect(CONSENT_ACCEPT_CONTROL.test('Alle Cookies erlauben')).toBe(true)
  expect(CONSENT_ACCEPT_CONTROL.test('Accept all cookies')).toBe(true)
})

test('navigation and settings links are not consent choices', () => {
  for (const text of ['Cookie-Einstellungen', 'Dedicated', 'Close', 'Mehr erfahren']) {
    expect(CONSENT_REJECT_CONTROL.test(text)).toBe(false)
    expect(CONSENT_ACCEPT_CONTROL.test(text)).toBe(false)
  }
})
