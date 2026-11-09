import { standardStyleName } from '@open-pencil/scene-graph/font-style'

export interface FontFamilyAlias {
  family: string
  style: string
}

interface StyleSuffix {
  suffix: string
  weight: number
  italic: boolean
}

/** Style words that many web fonts put in the family name instead of `font-weight`. */
const STYLE_SUFFIXES: StyleSuffix[] = [
  { suffix: 'ExtraBlackItalic', weight: 900, italic: true },
  { suffix: 'BlackItalic', weight: 900, italic: true },
  { suffix: 'SemiBoldItalic', weight: 600, italic: true },
  { suffix: 'MediumItalic', weight: 500, italic: true },
  { suffix: 'LightItalic', weight: 300, italic: true },
  { suffix: 'BookItalic', weight: 400, italic: true },
  { suffix: 'BoldItalic', weight: 700, italic: true },
  { suffix: 'ThinItalic', weight: 100, italic: true },
  { suffix: 'BolIta', weight: 700, italic: true },
  { suffix: 'ExtraBlack', weight: 900, italic: false },
  { suffix: 'SemiBold', weight: 600, italic: false },
  { suffix: 'Black', weight: 900, italic: false },
  { suffix: 'Medium', weight: 500, italic: false },
  { suffix: 'Light', weight: 300, italic: false },
  { suffix: 'Book', weight: 400, italic: false },
  { suffix: 'Bold', weight: 700, italic: false },
  { suffix: 'Thin', weight: 100, italic: false },
  { suffix: 'Italic', weight: 400, italic: true },
  { suffix: 'Regular', weight: 400, italic: false }
]

function styleSuffix(family: string): { base: string; style: string } | null {
  for (const entry of STYLE_SUFFIXES) {
    if (family.length <= entry.suffix.length) continue
    if (!family.toLowerCase().endsWith(entry.suffix.toLowerCase())) continue
    const base = family.slice(0, -entry.suffix.length).replace(/[\s_-]+$/, '')
    if (!base) continue
    return { base, style: standardStyleName(entry.weight, entry.italic) }
  }
  return null
}

/**
 * The faces a page's `@font-face` rule should be registered under. Fonts such as
 * `CircularXXWeb-Bold` put the weight in the family name while text asks for that weight on the
 * base family, so the same file is registered for both spellings.
 */
export function fontFamilyAliases(family: string, style: string): FontFamilyAlias[] {
  const parsed = styleSuffix(family)
  if (!parsed) return [{ family, style }]
  const aliases: FontFamilyAlias[] = [
    { family, style },
    { family, style: parsed.style },
    { family: parsed.base, style: parsed.style }
  ]
  // A face filed under "...Bold" also answers a semi-bold request in that family, as the
  // browser synthesizes the weight from the only face the family has.
  if (parsed.style === 'Bold') aliases.push({ family, style: 'SemiBold' })
  if (parsed.style === style) aliases.push({ family: parsed.base, style })
  const seen = new Set<string>()
  return aliases.filter((alias) => {
    const key = `${alias.family}|${alias.style}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
