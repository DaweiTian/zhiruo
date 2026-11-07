import { describe, expect, it } from 'vitest'
import {
  buildHubSectors,
  edgeFromRingCenter,
  HUB_ACTIONS,
  HUB_RING_CENTER,
  HUB_VIEW_SIZE,
  labelFlowFor,
  polar,
  RING_INNER_R,
  RING_OUTER_R,
  type HubDockEdge,
} from './hub-geometry'

const EDGES: readonly (HubDockEdge | null)[] = ['left', 'right', 'top', 'bottom', null]

/** 角度归一到 (-180, 180]。 */
function norm(deg: number): number {
  const v = ((((deg + 180) % 360) + 360) % 360) - 180
  return v
}

describe('hub ring geometry', () => {
  it('full ring: three equal sectors with 8° gaps around the capsule', () => {
    const sectors = buildHubSectors(null)
    expect(sectors).toHaveLength(3)
    expect(sectors.map((s) => s.action)).toEqual(['translate', 'polish', 'explain'])
    // 定稿图位置：翻译正上、润色右下、解释左下。
    expect(sectors.map((s) => s.midAngle)).toEqual([-90, 30, 150])

    // 扇形两两不重叠，间隙 = 8°。
    const sorted = [...sectors].sort((a, b) => a.midAngle - b.midAngle)
    for (let i = 0; i < sorted.length; i += 1) {
      const cur = sorted[i]
      const next = sorted[(i + 1) % sorted.length]
      const gap = norm(next.midAngle - 56 - (cur.midAngle + 56))
      expect(gap).toBeCloseTo(8, 5)
    }
  })

  it('every edge opens the half ring toward the screen interior', () => {
    for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
      const sectors = buildHubSectors(edge)
      expect(sectors).toHaveLength(3)
      for (const sector of sectors) {
        const [x, y] = polar(sector.midAngle, (RING_INNER_R + RING_OUTER_R) / 2)
        // 半环所有扇形必须落在屏幕内侧（贴边一侧不画）。
        if (edge === 'right') expect(x).toBeLessThan(HUB_RING_CENTER)
        if (edge === 'left') expect(x).toBeGreaterThan(HUB_RING_CENTER)
        if (edge === 'top') expect(y).toBeGreaterThan(HUB_RING_CENTER)
        if (edge === 'bottom') expect(y).toBeLessThan(HUB_RING_CENTER)
      }
    }
  })

  it('right-edge half ring matches the approved diagram (translate top-left, explain bottom-left)', () => {
    const sectors = buildHubSectors('right')
    const byAction = Object.fromEntries(sectors.map((s) => [s.action, s.midAngle]))
    expect(byAction).toEqual({ translate: 240, polish: 180, explain: 120 })
  })

  it('half-ring sectors keep 8° gaps and hug the interior 180° arc', () => {
    for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
      const span = 52
      const sectors = buildHubSectors(edge)
        .slice()
        .sort((a, b) => a.midAngle - b.midAngle)
      for (let i = 0; i < sectors.length - 1; i += 1) {
        const gap = norm(sectors[i + 1].midAngle - span / 2 - (sectors[i].midAngle + span / 2))
        expect(gap).toBeCloseTo(8, 5)
      }
    }
  })

  it('label flow never renders text upside down', () => {
    // 上半环顺时针、下半环逆时针。
    expect(labelFlowFor(-90)).toBe('cw')
    expect(labelFlowFor(240)).toBe('cw')
    expect(labelFlowFor(270)).toBe('cw')
    expect(labelFlowFor(30)).toBe('ccw')
    expect(labelFlowFor(120)).toBe('ccw')
    expect(labelFlowFor(150)).toBe('ccw')
    // 水平位置取「自上而下」。
    expect(labelFlowFor(0)).toBe('cw')
    expect(labelFlowFor(180)).toBe('ccw')

    for (const edge of EDGES) {
      for (const sector of buildHubSectors(edge)) {
        const expected = labelFlowFor(sector.midAngle)
        expect(sector.flow).toBe(expected)
        // 顺时针文字字身朝外（基线内收），逆时针朝内（基线外推）。
        const mid = (RING_INNER_R + RING_OUTER_R) / 2
        expect(sector.labelRadius).toBeCloseTo(expected === 'cw' ? mid - 5 : mid + 5, 5)
      }
    }
  })

  it('paths are well-formed with in-viewBox anchors', () => {
    for (const edge of EDGES) {
      for (const sector of buildHubSectors(edge)) {
        expect(sector.fillPath.startsWith('M ')).toBe(true)
        expect(sector.fillPath.endsWith(' Z')).toBe(true)
        expect(sector.fillPath).toContain(' A ')
        expect(sector.labelPath.startsWith('M ')).toBe(true)
        expect(sector.labelPath).toContain(' A ')
        // 锚点（M 后的坐标对）必须落在 viewBox 内。
        for (const path of [sector.fillPath, sector.labelPath]) {
          const m = /^M (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/.exec(path)
          if (!m) throw new Error(`path has no M anchor: ${path}`)
          const x = Number(m[1])
          const y = Number(m[2])
          expect(x).toBeGreaterThanOrEqual(0)
          expect(x).toBeLessThanOrEqual(HUB_VIEW_SIZE)
          expect(y).toBeGreaterThanOrEqual(0)
          expect(y).toBeLessThanOrEqual(HUB_VIEW_SIZE)
        }
      }
    }
  })

  it('exposes all actions in a stable display order', () => {
    expect(HUB_ACTIONS).toEqual(['translate', 'polish', 'explain'])
  })
})

describe('edgeFromRingCenter', () => {
  it('returns null when the full ring fits inside the window', () => {
    expect(edgeFromRingCenter({ x: HUB_RING_CENTER, y: HUB_RING_CENTER })).toBeNull()
    // 环恰好与窗口边相切（溢出 0）仍算放得下。
    expect(edgeFromRingCenter({ x: HUB_VIEW_SIZE - RING_OUTER_R, y: HUB_RING_CENTER })).toBeNull()
    expect(edgeFromRingCenter({ x: RING_OUTER_R, y: HUB_RING_CENTER })).toBeNull()
    expect(edgeFromRingCenter({ x: HUB_RING_CENTER, y: RING_OUTER_R })).toBeNull()
    expect(edgeFromRingCenter({ x: HUB_RING_CENTER, y: HUB_VIEW_SIZE - RING_OUTER_R })).toBeNull()
  })

  it('picks the edge the ring center overflows past', () => {
    expect(edgeFromRingCenter({ x: 250, y: HUB_RING_CENTER })).toBe('right')
    expect(edgeFromRingCenter({ x: 10, y: HUB_RING_CENTER })).toBe('left')
    expect(edgeFromRingCenter({ x: HUB_RING_CENTER, y: 10 })).toBe('top')
    expect(edgeFromRingCenter({ x: HUB_RING_CENTER, y: 250 })).toBe('bottom')
  })

  it('near an edge but not flush still derives the half-ring', () => {
    // 胶囊距右边缘 < RING_OUTER_R：全环会缺一角，必须转半环。
    expect(edgeFromRingCenter({ x: 180, y: HUB_RING_CENTER })).toBe('right')
  })

  it('corner case takes the nearer edge, ties resolve deterministically', () => {
    // 右溢出 78 > 上溢出 68 → right。
    expect(edgeFromRingCenter({ x: 250, y: 20 })).toBe('right')
    // 并列（各溢出 78）：按右 / 左 / 下 / 上取先者 → right。
    expect(edgeFromRingCenter({ x: 250, y: 10 })).toBe('right')
    expect(edgeFromRingCenter({ x: 10, y: 10 })).toBe('left')
  })
})
