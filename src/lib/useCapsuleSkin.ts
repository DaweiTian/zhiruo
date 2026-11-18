import { useMemo, useSyncExternalStore } from 'react'

/** 胶囊皮肤：经典图标款 / 叶精灵宠物款（功能方案设计 4.2）。纯外观偏好，走
 *  localStorage（同 `useTheme` 模式），不进 Rust 配置——默认 `classic` 零变化。 */
export type CapsuleSkin = 'classic' | 'pet'

export const CAPSULE_SKINS = ['classic', 'pet'] as const

const STORAGE_KEY = 'vk-capsule-skin'
const DEFAULT_SKIN: CapsuleSkin = 'classic'

export function resolveCapsuleSkin(stored: string | null): CapsuleSkin {
  return stored === 'pet' ? 'pet' : DEFAULT_SKIN
}

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function persistSkin(skin: CapsuleSkin) {
  try {
    localStorage.setItem(STORAGE_KEY, skin)
  } catch {
    /* ignore */
  }
}

/* 模块级共享 store：与 useTheme 同款——设置页与 HUD/SessionHUD 可能同时挂载，
   各自 useState 会失同步；storage 事件负责跨窗口（设置页改、悬浮窗跟）。 */
const subscribers = new Set<() => void>()
let snapshotCache: CapsuleSkin | null = null

function getSnapshot(): CapsuleSkin {
  if (snapshotCache === null) snapshotCache = resolveCapsuleSkin(readStored())
  return snapshotCache
}

function commit(next: CapsuleSkin) {
  snapshotCache = next
  subscribers.forEach((listener) => listener())
}

function handleStorageEvent(event: StorageEvent) {
  if (event.key !== null && event.key !== STORAGE_KEY) return
  commit(resolveCapsuleSkin(readStored()))
}

let storageListenerInstalled = false

function subscribe(onStoreChange: () => void): () => void {
  if (!storageListenerInstalled) {
    storageListenerInstalled = true
    window.addEventListener('storage', handleStorageEvent)
  }
  subscribers.add(onStoreChange)
  return () => subscribers.delete(onStoreChange)
}

function setSkin(next: CapsuleSkin) {
  if (getSnapshot() === next) return
  persistSkin(next)
  commit(next)
}

/** 胶囊皮肤：模块级共享状态，持久化到 localStorage 并跨窗口同步。 */
export function useCapsuleSkin(): { skin: CapsuleSkin; setSkin: (skin: CapsuleSkin) => void } {
  const skin = useSyncExternalStore(subscribe, getSnapshot)
  return useMemo(() => ({ skin, setSkin }), [skin])
}
