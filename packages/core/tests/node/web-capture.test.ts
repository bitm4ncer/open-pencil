import { expect, test } from 'bun:test'

import { OVERLAY_DISMISS_LABELS } from '#core/node/web-capture'

test('overlay labels are readable text rather than mis-decoded bytes', () => {
  expect(OVERLAY_DISMISS_LABELS.length).toBeGreaterThan(0)
  for (const label of OVERLAY_DISMISS_LABELS) {
    expect(label).not.toMatch(/[\uFFFDÃÂ]/)
  }
})
