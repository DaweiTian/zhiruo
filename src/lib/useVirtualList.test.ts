import { describe, expect, it } from 'vitest'
import { buildVirtualOffsets, computeVirtualWindow, type VirtualRow } from './useVirtualList'

const rows: VirtualRow[] = [
  { key: 'h1', estimate: 40 },
  { key: 'a', estimate: 100 },
  { key: 'b', estimate: 100 },
  { key: 'h2', estimate: 40 },
  { key: 'c', estimate: 100 },
]

describe('buildVirtualOffsets', () => {
  it('accumulates estimates when nothing is measured', () => {
    expect(buildVirtualOffsets(rows, new Map())).toEqual([0, 40, 140, 240, 280, 380])
  })

  it('prefers measured heights over estimates', () => {
    const heights = new Map([
      ['a', 120],
      ['c', 80],
    ])
    expect(buildVirtualOffsets(rows, heights)).toEqual([0, 40, 160, 260, 300, 380])
  })

  it('ignores non-positive measured heights', () => {
    const heights = new Map([['a', 0]])
    expect(buildVirtualOffsets(rows, heights)[2]).toBe(140)
  })

  it('returns a single zero for an empty row list', () => {
    expect(buildVirtualOffsets([], new Map())).toEqual([0])
  })
})

describe('computeVirtualWindow', () => {
  const offsets = [0, 40, 140, 240, 280, 380]

  it('covers the visible slice plus overscan rows', () => {
    // 视口 140-240（b 行）：±1 行 overscan 应当带上 a 与 h2。
    const w = computeVirtualWindow(offsets, 140, 100, 1)
    expect(w.start).toBe(1)
    expect(w.end).toBe(4)
    expect(w.topSpacer).toBe(40)
    expect(w.bottomSpacer).toBe(380 - 280)
  })

  it('clamps to the list bounds at the start', () => {
    const w = computeVirtualWindow(offsets, 0, 30, 2)
    expect(w.start).toBe(0)
    expect(w.topSpacer).toBe(0)
  })

  it('clamps to the list bounds at the end', () => {
    const w = computeVirtualWindow(offsets, 300, 200, 2)
    expect(w.end).toBe(5)
    expect(w.bottomSpacer).toBe(0)
    expect(w.topSpacer).toBe(offsets[2])
  })

  it('always renders at least one row for a non-empty list', () => {
    const w = computeVirtualWindow(offsets, 5000, 0, 0)
    expect(w.end - w.start).toBeGreaterThanOrEqual(1)
  })

  it('returns an empty window for no rows', () => {
    expect(computeVirtualWindow([0], 0, 100, 8)).toEqual({
      start: 0,
      end: 0,
      topSpacer: 0,
      bottomSpacer: 0,
    })
  })
})
