import { useMemo, useSyncExternalStore } from 'react'

/** 界面主题：科幻（暗）/ 清新（亮）/ 商务（亮）。 */
export type Theme = 'scifi' | 'fresh' | 'business'

export const THEMES = ['scifi', 'fresh', 'business'] as const

export interface ThemeOption {
  id: Theme
  nameKey: string
  isDark: boolean
  /** 主题卡预览色板：背景 / 文字 / 主色 */
  previewBg: string
  previewFg: string
  previewPrimary: string
}

export const THEME_OPTIONS: ThemeOption[] = [
  {
    id: 'scifi',
    nameKey: 'theme.scifi',
    isDark: true,
    previewBg: 'oklch(0.165 0.022 255)',
    previewFg: 'oklch(0.93 0.015 200)',
    previewPrimary: 'oklch(0.79 0.13 195)',
  },
  {
    id: 'fresh',
    nameKey: 'theme.fresh',
    isDark: false,
    previewBg: 'oklch(0.985 0.008 150)',
    previewFg: 'oklch(0.245 0.018 155)',
    previewPrimary: 'oklch(0.655 0.125 155)',
  },
  {
    id: 'business',
    nameKey: 'theme.business',
    isDark: false,
    previewBg: 'oklch(0.972 0.004 255)',
    previewFg: 'oklch(0.235 0.012 255)',
    previewPrimary: 'oklch(0.47 0.125 255)',
  },
]

export const ACCENTS = [
  'auto',
  'gulf-blue',
  'olive-green',
  'lava-orange',
  'sunset-purple',
  'elegant-grey',
  'classic',
] as const

export type Accent = (typeof ACCENTS)[number]

export interface AccentOption {
  id: Accent
  nameKey: string
  /** 用作 CSS background，纯色或渐变均可 */
  swatch: string
}

/** `auto` = 跟随当前主题自带主色，不写 data-accent。 */
export const ACCENT_OPTIONS: AccentOption[] = [
  {
    id: 'auto',
    nameKey: 'theme.accent.auto',
    swatch:
      'conic-gradient(from 210deg, oklch(0.79 0.13 195), oklch(0.655 0.125 155), oklch(0.47 0.125 255), oklch(0.79 0.13 195))',
  },
  { id: 'gulf-blue', nameKey: 'theme.accent.gulfBlue', swatch: 'oklch(0.62 0.19 245)' },
  { id: 'olive-green', nameKey: 'theme.accent.oliveGreen', swatch: 'oklch(0.66 0.14 135)' },
  { id: 'lava-orange', nameKey: 'theme.accent.lavaOrange', swatch: 'oklch(0.68 0.2 45)' },
  { id: 'sunset-purple', nameKey: 'theme.accent.sunsetPurple', swatch: 'oklch(0.62 0.2 300)' },
  { id: 'elegant-grey', nameKey: 'theme.accent.elegantGrey', swatch: 'oklch(0.72 0.04 250)' },
  { id: 'classic', nameKey: 'theme.accent.classic', swatch: 'oklch(0.755 0.176 63)' },
]

const THEME_STORAGE_KEY = 'vk-theme'
/** 旧键 vk-accent 总是被写入隐式默认值，无法区分「用户选过」；换键让默认回到「跟随主题」。 */
const ACCENT_STORAGE_KEY = 'vk-accent-v2'
const DEFAULT_THEME: Theme = 'fresh'
const TRANSITION_SUPPRESS_CLASS = 'vk-theme-changing'

let transitionFrame = 0
let transitionFallbackTimer = 0

export function isDarkTheme(theme: Theme): boolean {
  return theme === 'scifi'
}

function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value)
}

function isAccent(value: unknown): value is Accent {
  return typeof value === 'string' && (ACCENTS as readonly string[]).includes(value)
}

/** 持久化值归一：老的 light/dark 迁移到新主题，非法值返回 null。 */
export function resolveTheme(stored: string | null): Theme | null {
  if (isTheme(stored)) return stored
  if (stored === 'dark') return 'scifi'
  if (stored === 'light') return 'fresh'
  return null
}

export function resolveAccent(stored: string | null): Accent {
  return isAccent(stored) ? stored : 'auto'
}

function prefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

function persistTheme(theme: Theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    /* ignore */
  }
}

function persistAccent(accent: Accent) {
  try {
    localStorage.setItem(ACCENT_STORAGE_KEY, accent)
  } catch {
    /* ignore */
  }
}

function applyTheme(theme: Theme) {
  const root = document.documentElement
  root.setAttribute('data-theme', theme)
  root.classList.toggle('dark', isDarkTheme(theme))
  root.style.colorScheme = isDarkTheme(theme) ? 'dark' : 'light'
}

function applyAccent(accent: Accent) {
  const root = document.documentElement
  if (accent === 'auto') root.removeAttribute('data-accent')
  else root.setAttribute('data-accent', accent)
}

function releaseTransitionSuppression() {
  const root = document.documentElement
  root.classList.remove(TRANSITION_SUPPRESS_CLASS)

  if (transitionFrame) {
    window.cancelAnimationFrame(transitionFrame)
    transitionFrame = 0
  }
  if (transitionFallbackTimer) {
    window.clearTimeout(transitionFallbackTimer)
    transitionFallbackTimer = 0
  }
}

function runWithoutTransitions(action: () => void) {
  const root = document.documentElement
  root.classList.add(TRANSITION_SUPPRESS_CLASS)
  root.getBoundingClientRect()
  action()

  if (transitionFrame) window.cancelAnimationFrame(transitionFrame)
  if (transitionFallbackTimer) window.clearTimeout(transitionFallbackTimer)

  transitionFrame = window.requestAnimationFrame(() => {
    transitionFrame = window.requestAnimationFrame(releaseTransitionSuppression)
  })
  transitionFallbackTimer = window.setTimeout(releaseTransitionSuppression, 140)
}

/* ------------------------------------------------------------------
   模块级共享 store：侧栏与设置页同时挂载 useTheme，若各自 useState 会
   互相失同步（一处切换后另一处高亮卡死、再次点击变成 no-op）。
   故状态收敛到模块级，useSyncExternalStore 订阅。
   getSnapshot 只读缓存不写 DOM（快照纯度）；DOM 应用集中在
   initThemeStore / set*Shared / subscribe 首订。
   ------------------------------------------------------------------ */

interface ThemeSnapshot {
  theme: Theme
  accent: Accent
}

const subscribers = new Set<() => void>()
let store: ThemeSnapshot | null = null
let snapshotCache: ThemeSnapshot | null = null
let domApplied = false

function ensureState(): ThemeSnapshot {
  if (!store) {
    // 老存储值（light/dark、无 v2 强调色）迁移后落盘，避免内存归一、磁盘永留旧值
    let rawTheme: string | null = null
    try {
      rawTheme = localStorage.getItem(THEME_STORAGE_KEY)
    } catch {
      /* ignore */
    }
    const theme = resolveTheme(rawTheme) ?? (prefersDark() ? 'scifi' : DEFAULT_THEME)
    if (rawTheme !== theme) persistTheme(theme)

    let rawAccent: string | null = null
    try {
      rawAccent = localStorage.getItem(ACCENT_STORAGE_KEY)
    } catch {
      /* ignore */
    }
    const accent = resolveAccent(rawAccent)
    if (rawAccent !== accent) persistAccent(accent)

    store = { theme, accent }
    snapshotCache = store
  }
  return store
}

function applyToDom(snapshot: ThemeSnapshot) {
  applyTheme(snapshot.theme)
  applyAccent(snapshot.accent)
  domApplied = true
}

/** 幂等：把持久化中的主题/强调色应用到当前窗口 <html>。main.tsx 对所有窗口入口调用。 */
export function initThemeStore() {
  applyToDom(ensureState())
}

function getSnapshot(): ThemeSnapshot {
  return snapshotCache ?? (snapshotCache = ensureState())
}

function subscribe(onStoreChange: () => void): () => void {
  const current = ensureState()
  if (!domApplied) applyToDom(current)
  subscribers.add(onStoreChange)
  return () => subscribers.delete(onStoreChange)
}

function commitStore(next: ThemeSnapshot) {
  store = next
  snapshotCache = next
  subscribers.forEach((listener) => listener())
}

function setThemeShared(next: Theme) {
  const current = ensureState()
  if (current.theme === next) return
  runWithoutTransitions(() => applyTheme(next))
  persistTheme(next)
  commitStore({ ...current, theme: next })
}

function setAccentShared(next: Accent) {
  const current = ensureState()
  if (current.accent === next) return
  runWithoutTransitions(() => applyAccent(next))
  persistAccent(next)
  commitStore({ ...current, accent: next })
}

/** 界面主题与强调色：模块级共享状态，持久化到 localStorage 并同步到 <html>。 */
export function useTheme(): {
  theme: Theme
  setTheme: (theme: Theme) => void
  accent: Accent
  setAccent: (accent: Accent) => void
} {
  const state = useSyncExternalStore(subscribe, getSnapshot)
  return useMemo(
    () => ({
      theme: state.theme,
      setTheme: setThemeShared,
      accent: state.accent,
      setAccent: setAccentShared,
    }),
    [state.theme, state.accent],
  )
}
