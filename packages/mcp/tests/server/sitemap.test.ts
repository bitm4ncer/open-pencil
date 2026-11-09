import { expect, test } from 'bun:test'

import { parseSitemapLocs } from '#mcp/server/sitemap'

test('reads the page URLs of a sitemap in order', () => {
  const xml = `<?xml version="1.0"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://example.com/</loc></url>
      <url><loc>https://example.com/about?team=design&amp;lang=de</loc></url>
    </urlset>`

  expect(parseSitemapLocs(xml)).toEqual([
    'https://example.com/',
    'https://example.com/about?team=design&lang=de'
  ])
})

test('reads the child sitemaps of a sitemap index', () => {
  const xml = `<sitemapindex>
    <sitemap><loc>https://example.com/pages.xml</loc></sitemap>
    <sitemap><loc>https://example.com/posts.xml</loc></sitemap>
  </sitemapindex>`

  expect(parseSitemapLocs(xml)).toEqual([
    'https://example.com/pages.xml',
    'https://example.com/posts.xml'
  ])
})
