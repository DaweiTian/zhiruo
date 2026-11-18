import * as React from 'react'

/**
 * 历史页虚拟滚动（功能方案设计 3.3）：扁平行模型 + 估高 + 测量修正。
 * 滚动容器是外层布局的 `.vk-scroll`（MainLayout 内容区），列表只渲染
 * 视口 ± overscan 的行，上下用 spacer 撑住总滚动高度。
 */

/** 扁平行的估高输入：`key` 供测量缓存索引，`estimate` 为未测量时的回退高度。 */
export interface VirtualRow {
  key: string
  estimate: number
}

/**
 * 累计高度表：`offsets[i]` = 第 i 行顶边，`offsets[rows.length]` = 总高。
 * 已测量行用测量值，未测量行用估算值。
 */
export function buildVirtualOffsets(
  rows: readonly VirtualRow[],
  heights: ReadonlyMap<string, number>,
): number[] {
  const offsets = new Array<number>(rows.length + 1)
  offsets[0] = 0
  for (let i = 0; i < rows.length; i += 1) {
    const measured = heights.get(rows[i].key)
    const height = measured !== undefined && measured > 0 ? measured : rows[i].estimate
    offsets[i + 1] = offsets[i] + height
  }
  return offsets
}

export interface VirtualWindow {
  /** 可见区间 `[start, end)`（已含 overscan）。 */
  start: number
  end: number
  topSpacer: number
  bottomSpacer: number
}

/**
 * 视口覆盖的行区间（± `overscanRows` 行）。坐标系与 `offsets` 一致：
 * `viewportTop` 是视口顶边在列表坐标系里的位置。
 */
export function computeVirtualWindow(
  offsets: readonly number[],
  viewportTop: number,
  viewportHeight: number,
  overscanRows = 8,
): VirtualWindow {
  const count = Math.max(0, offsets.length - 1)
  if (count === 0) {
    return { start: 0, end: 0, topSpacer: 0, bottomSpacer: 0 }
  }
  const top = Math.max(0, viewportTop)
  const bottom = viewportTop + viewportHeight
  let start = 0
  while (start < count - 1 && offsets[start + 1] <= top) {
    start += 1
  }
  let end = start
  while (end < count && offsets[end] < bottom) {
    end += 1
  }
  start = Math.max(0, start - overscanRows)
  end = Math.min(count, Math.max(end, start + 1) + overscanRows)
  return {
    start,
    end,
    topSpacer: offsets[start],
    bottomSpacer: offsets[count] - offsets[end],
  }
}

function findScrollContainer(listEl: HTMLElement | null): HTMLElement | null {
  return (listEl?.closest('.vk-scroll') as HTMLElement | null) ?? null
}

export interface VirtualListResult {
  visibleWindow: VirtualWindow
  /** 行包裹元素的稳定 ref 回调（按 key 缓存，避免逐渲染重挂）。 */
  measureRef: (key: string) => (el: HTMLElement | null) => void
}

/**
 * 变高行的虚拟窗口。`listRef` 挂在扁平行列表的容器上；滚动容器取其最近的
 * `.vk-scroll` 祖先（MainLayout 内容区），视口变化与行高测量都会重算窗口。
 */
export function useVirtualList(
  rows: readonly VirtualRow[],
  listRef: React.RefObject<HTMLElement | null>,
  overscanRows = 8,
): VirtualListResult {
  const heightsRef = React.useRef(new Map<string, number>())
  const rowsRef = React.useRef(rows)
  const observerRef = React.useRef<ResizeObserver | null>(null)
  const measureRefCacheRef = React.useRef(new Map<string, (el: HTMLElement | null) => void>())
  const observedRef = React.useRef(new Map<string, HTMLElement>())
  // 测量版本：ResizeObserver 写缓存后 bump，作为 offsets 的 memo 依赖——
  // 重渲染本身不会让 deps=[rows] 的 memo 重算，缺了它实测高度进不了布局。
  const [measureTick, setMeasureTick] = React.useState(0)
  const [viewport, setViewport] = React.useState({ top: 0, height: 0 })

  React.useEffect(() => {
    rowsRef.current = rows
    // 测量缓存按 key 裁剪：删除/搜索淘汰的行不再占内存（数字缓存清理即可，
    // ref 回调缓存只是小闭包，卸载时由 React 调 null 自行解观察）。
    const alive = new Set(rows.map((row) => row.key))
    for (const key of [...heightsRef.current.keys()]) {
      if (!alive.has(key)) heightsRef.current.delete(key)
    }
  }, [rows])

  // 滚动容器 = 布局的 .vk-scroll；监听 scroll/resize 维护视口矩形。
  // 依赖 rows：列表可能尚未挂载（历史页 loading 早退时 listRef 为空），
  // 数据到位后本 effect 重跑补挂监听。
  React.useEffect(() => {
    const listEl = listRef.current
    const scroller = findScrollContainer(listEl)
    if (!scroller) return

    const listTopInScroller = () =>
      listEl
        ? listEl.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop
        : 0

    const sync = () => {
      const top = scroller.scrollTop - listTopInScroller()
      const height = scroller.clientHeight
      setViewport((prev) => (prev.top === top && prev.height === height ? prev : { top, height }))
    }
    sync()
    scroller.addEventListener('scroll', sync, { passive: true })
    window.addEventListener('resize', sync)
    return () => {
      scroller.removeEventListener('scroll', sync)
      window.removeEventListener('resize', sync)
    }
  }, [listRef, rows])

  // 行高测量：ResizeObserver 写缓存；视口之上的行变高/变矮时补偿 scrollTop，
  // 避免测量修正把可视内容推走（「估高 + 滚动锚定」缓解）。
  React.useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      const listEl = listRef.current
      const scroller = findScrollContainer(listEl)
      let viewportTopInList = 0
      if (scroller && listEl) {
        const listTop =
          listEl.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop
        viewportTopInList = scroller.scrollTop - listTop
      }
      const prevOffsets = buildVirtualOffsets(rowsRef.current, heightsRef.current)
      const keyIndex = new Map<string, number>()
      rowsRef.current.forEach((row, index) => keyIndex.set(row.key, index))

      let scrollDelta = 0
      let changed = false
      for (const entry of entries) {
        const el = entry.target as HTMLElement
        let key: string | undefined
        for (const [k, observed] of observedRef.current) {
          if (observed === el) {
            key = k
            break
          }
        }
        if (key === undefined) continue
        const next =
          entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height
        const prev = heightsRef.current.get(key)
        if (prev !== undefined && Math.abs(prev - next) <= 0.5) continue
        heightsRef.current.set(key, next)
        changed = true
        const index = keyIndex.get(key)
        if (
          index !== undefined &&
          prev !== undefined &&
          prevOffsets[index] + prev <= viewportTopInList
        ) {
          scrollDelta += next - prev
        }
      }
      if (scrollDelta !== 0 && scroller) {
        scroller.scrollTop += scrollDelta
      }
      if (changed) setMeasureTick((tick) => tick + 1)
    })
    observerRef.current = observer
    // 首挂时序：ref 回调早于本 effect 执行，此前挂上的元素只登记未观察，
    // 这里补一轮 observe（无 loading 门的复用方也稳）。
    for (const el of observedRef.current.values()) {
      observer.observe(el)
    }
    return () => {
      observer.disconnect()
      observerRef.current = null
    }
  }, [listRef])

  const measureRef = React.useCallback((key: string) => {
    let fn = measureRefCacheRef.current.get(key)
    if (!fn) {
      fn = (el: HTMLElement | null) => {
        const observer = observerRef.current
        const observed = observedRef.current.get(key)
        if (observed && observed !== el) {
          observer?.unobserve(observed)
          observedRef.current.delete(key)
        }
        if (el) {
          // 先登记后观察：observer 未就绪时由 effect 首建后统一补 observe。
          observedRef.current.set(key, el)
          observer?.observe(el)
        }
      }
      measureRefCacheRef.current.set(key, fn)
    }
    return fn
  }, [])

  const offsets = React.useMemo(
    () => buildVirtualOffsets(rows, heightsRef.current),
    // measureTick 是测量修正的重算信号：实测高度写入 heightsRef 后必须重算
    // offsets，否则窗口与 spacer 一直按估高滑动（审查 H1）。
    [rows, measureTick],
  )

  const visibleWindow = React.useMemo(
    () => computeVirtualWindow(offsets, viewport.top, viewport.height, overscanRows),
    [offsets, viewport.top, viewport.height, overscanRows],
  )

  return {
    visibleWindow,
    measureRef,
  }
}
