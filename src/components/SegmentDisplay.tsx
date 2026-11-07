import { getSegments, isDotChar } from '@/lib/segment-display'
import { cn } from '@/lib/utils'

interface SegmentDisplayProps {
  /** 要显示的文本（版本号等）；支持 0-9、小数点、冒号、- _ = */
  value: string
  className?: string
}

/** 数码管单元格几何（viewBox 坐标） */
const CELL_W = 14
const DOT_W = 7
const CELL_H = 26
const T = 2.6

function hSeg(x: number, y: number, len: number): string {
  return [
    [x, y + T / 2],
    [x + T / 2, y],
    [x + len - T / 2, y],
    [x + len, y + T / 2],
    [x + len - T / 2, y + T],
    [x + T / 2, y + T],
  ]
    .map(([px, py]) => `${px},${py}`)
    .join(' ')
}

function vSeg(x: number, y: number, len: number): string {
  return [
    [x + T / 2, y],
    [x + T, y + T / 2],
    [x + T, y + len - T / 2],
    [x + T / 2, y + len],
    [x, y + len - T / 2],
    [x, y + T / 2],
  ]
    .map(([px, py]) => `${px},${py}`)
    .join(' ')
}

const SEG_POLY: Record<string, string> = {
  a: hSeg(3, 1.3, 8),
  g: hSeg(3, 11.7, 8),
  d: hSeg(3, 22.1, 8),
  f: vSeg(1.5, 3.2, 7.2),
  b: vSeg(9.9, 3.2, 7.2),
  e: vSeg(1.5, 14.8, 6.6),
  c: vSeg(9.9, 14.8, 6.6),
}

const ALL_SEGS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const

/**
 * 七段数码管显示：暗底 LED 模块 + 分段数字，点亮段继承主题主色并带辉光，
 * 未点亮段保留幽灵段（真实数码管的暗段质感）。
 */
export function SegmentDisplay({ value, className }: SegmentDisplayProps) {
  const chars = Array.from(value)
  let x = 0
  const cells = chars.map((ch) => {
    const width = isDotChar(ch) ? DOT_W : CELL_W
    const cell = { ch, x, width }
    x += width + 1.5
    return cell
  })
  const totalW = Math.max(x - 1.5, CELL_W)
  const height = 18
  const width = Math.round((height * totalW) / CELL_H)

  return (
    <svg
      viewBox={`0 0 ${totalW} ${CELL_H}`}
      width={width}
      height={height}
      role={chars.length > 0 ? 'img' : undefined}
      aria-label={chars.length > 0 ? value : undefined}
      aria-hidden={chars.length > 0 ? undefined : true}
      className={cn('vk-seg-plate-svg', className)}
    >
      <g className="vk-seg-off">
        {cells.map((cell, i) =>
          isDotChar(cell.ch) ? null : (
            <g key={`off-${i}`} transform={`translate(${cell.x} 0)`}>
              {ALL_SEGS.map((s) => (
                <polygon key={s} points={SEG_POLY[s]} />
              ))}
            </g>
          ),
        )}
      </g>
      <g className="vk-seg-on">
        {cells.map((cell, i) => {
          if (isDotChar(cell.ch)) {
            // 冒号两点关于单元中线（y=13）对称；小数点沉在基线
            const dots = cell.ch === ':' ? [7.2, 15.6] : [21.5]
            return (
              <g key={`on-${i}`} transform={`translate(${cell.x} 0)`}>
                {dots.map((dy) => (
                  <rect key={dy} x={1.6} y={dy} width={3.2} height={3.2} rx={1.1} />
                ))}
              </g>
            )
          }
          const segs = getSegments(cell.ch)
          return (
            <g key={`on-${i}`} transform={`translate(${cell.x} 0)`}>
              {ALL_SEGS.filter((s) => segs.includes(s)).map((s) => (
                <polygon key={s} points={SEG_POLY[s]} />
              ))}
            </g>
          )
        })}
      </g>
    </svg>
  )
}
