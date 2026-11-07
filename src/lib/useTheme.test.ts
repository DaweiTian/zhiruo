import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isDarkTheme, resolveAccent, resolveTheme, THEME_OPTIONS, THEMES } from './useTheme'

describe('resolveTheme', () => {
  it('keeps new theme ids', () => {
    expect(resolveTheme('scifi')).toBe('scifi')
    expect(resolveTheme('fresh')).toBe('fresh')
    expect(resolveTheme('business')).toBe('business')
  })

  it('migrates legacy light/dark values', () => {
    expect(resolveTheme('dark')).toBe('scifi')
    expect(resolveTheme('light')).toBe('fresh')
  })

  it('returns null for missing or unknown values', () => {
    expect(resolveTheme(null)).toBeNull()
    expect(resolveTheme('purple')).toBeNull()
    expect(resolveTheme('')).toBeNull()
  })
})

describe('resolveAccent', () => {
  it('keeps explicit accent picks and defaults to auto', () => {
    expect(resolveAccent('gulf-blue')).toBe('gulf-blue')
    expect(resolveAccent('olive-green')).toBe('olive-green')
    expect(resolveAccent(null)).toBe('auto')
    expect(resolveAccent('not-a-color')).toBe('auto')
  })
})

describe('theme catalog', () => {
  it('marks only scifi as dark', () => {
    expect(isDarkTheme('scifi')).toBe(true)
    expect(isDarkTheme('fresh')).toBe(false)
    expect(isDarkTheme('business')).toBe(false)
  })

  it('exposes one option per theme with matching darkness', () => {
    expect(THEMES).toEqual(['scifi', 'fresh', 'business'])
    expect(THEME_OPTIONS.map((option) => option.id)).toEqual([...THEMES])
    for (const option of THEME_OPTIONS) {
      expect(option.isDark).toBe(isDarkTheme(option.id))
    }
  })
})

describe('theme palettes in index.css', () => {
  const css = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8')

  const themeBlockVars = (id: string): Set<string> => {
    const match = css.match(new RegExp(`html\\[data-theme='${id}'\\][^{]*\\{([^}]*)\\}`))
    if (!match) throw new Error(`index.css 缺少主题色板块：${id}`)
    const vars = new Set<string>()
    for (const line of match[1].split('\n')) {
      const decl = line.match(/^\s*(--[a-z0-9-]+):/)
      if (decl) vars.add(decl[1])
    }
    return vars
  }

  it('every theme defines the same variable set', () => {
    const [first, ...rest] = THEMES.map(themeBlockVars)
    for (const vars of rest) {
      expect([...vars].sort()).toEqual([...first].sort())
    }
  })

  it('every theme defines all color vars referenced by @theme inline', () => {
    const inline = css.match(/@theme inline \{([^}]*)\}/)?.[1] ?? ''
    const referenced = [...inline.matchAll(/var\((--[a-z0-9-]+)\)/g)]
      .map((m) => m[1])
      // 阴影 / 圆角 / 字体在 :root 共享，不按主题分叉
      .filter(
        (name) => !name.startsWith('--font') && !name.startsWith('--shadow') && name !== '--radius',
      )
    expect(referenced.length).toBeGreaterThan(0)
    for (const theme of THEMES) {
      const vars = themeBlockVars(theme)
      for (const name of referenced) {
        expect(vars.has(name), `${theme} 缺少 ${name}`).toBe(true)
      }
    }
  })
})
