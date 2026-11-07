/**
 * 选区快捷动作 hub（`hub` 窗口）：右键常驻胶囊弹出的圆环动作面板。
 *
 * 形态（产品定稿，几何见 `lib/hub-geometry.ts`）：
 * - 自由悬浮：完整圆环均分扇区围绕胶囊（胶囊是 overlay 窗口，透过本窗中孔可见）；
 * - 贴靠屏幕边缘：只朝屏幕内展开半环（`dockEdge` 来自 Rust `hub-update`）。
 *
 * 状态流由 Rust `hub-update` 驱动：capturing → ready / empty / error →
 * processing → done（改写类，稍后自动收起）/ result（解释类，展示卡片）。
 * 扇区文字沿弧排布（`textPath`），展开动画见 index.css `.hub-sector-in`。
 */
import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  buildHubSectors,
  HUB_VIEW_SIZE,
  type HubAction,
  type HubDockEdge,
} from '@/lib/hub-geometry'
import { cn } from '@/lib/utils'
import type { HubUpdatePayload } from '@/lib/tauri-api'

type HubStatus = HubUpdatePayload['status']

interface HubState {
  status: HubStatus
  dockEdge: HubDockEdge | null
  preview: string
  result: string
  message: string
}

function toDockEdge(value: unknown): HubDockEdge | null {
  return value === 'left' || value === 'right' || value === 'top' || value === 'bottom'
    ? value
    : null
}

function readPayload(payload: HubUpdatePayload): HubState {
  return {
    status: payload.status ?? 'capturing',
    dockEdge: toDockEdge(payload.dockEdge),
    preview: payload.preview ?? '',
    result: payload.result ?? '',
    message: payload.message ?? '',
  }
}

const ACTION_LABEL_KEY: Record<HubAction, string> = {
  translate: 'hub.translate',
  polish: 'hub.polish',
  explain: 'hub.explain',
}

export function Hub() {
  const { t } = useTranslation()
  const [state, setState] = useState<HubState>({
    status: 'capturing',
    dockEdge: null,
    preview: '',
    result: '',
    message: '',
  })
  const [hovered, setHovered] = useState<HubAction | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const unsub = window.electronAPI.onHubUpdate((payload) => {
      setState(readPayload(payload))
    })
    return () => unsub()
  }, [])

  const sectors = useMemo(() => buildHubSectors(state.dockEdge), [state.dockEdge])

  // 只有 ready 态扇区可点；capturing / empty / processing / done / result 只读。
  const interactive = state.status === 'ready'
  const ringDimmed = state.status === 'processing' || state.status === 'done'

  const close = () => {
    void window.electronAPI.closeSelectionHub()
  }

  const runAction = (event: ReactMouseEvent, action: HubAction) => {
    event.stopPropagation()
    if (!interactive) return
    void window.electronAPI.runSelectionHubAction(action)
  }

  const copyResult = (event: ReactMouseEvent) => {
    event.stopPropagation()
    if (!state.result) return
    void window.electronAPI.copyText(state.result).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }

  const statusText = (() => {
    switch (state.status) {
      case 'capturing':
        return t('hub.capturing')
      case 'empty':
        return t('hub.noSelection')
      case 'processing':
        return t('hub.processing')
      case 'done':
        return t('hub.done')
      case 'error':
        return state.message || t('hub.error')
      default:
        return ''
    }
  })()

  return (
    // 背景点击 = 收起。扇区 / 结果卡片各自 stopPropagation，不冒泡到此。
    <div className="fixed inset-0 select-none overflow-hidden" onClick={close}>
      {/* 状态胶囊（top）：capturing / empty / processing / done / error。 */}
      {statusText && (
        <div className="pointer-events-none absolute inset-x-0 top-4 flex justify-center px-4">
          <div
            className={cn(
              'max-w-full truncate rounded-full px-3 py-1 text-[11px] ring-1',
              state.status === 'error'
                ? 'bg-red-950/80 text-red-200 ring-red-400/25'
                : 'bg-neutral-900/85 text-neutral-300 ring-white/10',
            )}
          >
            {statusText}
          </div>
        </div>
      )}

      {/* ready：选区预览一行（截断），提示动作对象。 */}
      {state.status === 'ready' && state.preview && (
        <div className="pointer-events-none absolute inset-x-0 top-4 flex justify-center px-6">
          <div className="max-w-full truncate rounded-full bg-neutral-900/70 px-3 py-1 text-[10px] text-neutral-400 ring-1 ring-white/[0.06]">
            {state.preview}
          </div>
        </div>
      )}

      {/* 圆环：viewBox 与 hub 窗口同尺寸，中孔透明露出下层胶囊。 */}
      <svg
        viewBox={`0 0 ${HUB_VIEW_SIZE} ${HUB_VIEW_SIZE}`}
        className={cn(
          'absolute inset-0 h-full w-full transition-opacity duration-200',
          ringDimmed && 'opacity-40',
        )}
      >
        <defs>
          {sectors.map((sector) => (
            // 文字沿弧的基线路径（不渲染）。
            <path
              key={sector.action}
              id={`hub-label-${sector.action}`}
              d={sector.labelPath}
              fill="none"
            />
          ))}
        </defs>
        {sectors.map((sector, index) => {
          const active = interactive && hovered === sector.action
          return (
            <g
              key={sector.action}
              className="hub-sector-in"
              style={{
                animationDelay: `${index * 45}ms`,
                pointerEvents: interactive ? 'auto' : 'none',
              }}
            >
              <path
                d={sector.fillPath}
                fill={active ? 'var(--primary)' : '#171717'}
                fillOpacity={active ? 0.42 : 0.72}
                stroke="rgba(255,255,255,0.10)"
                strokeWidth={1}
                style={{
                  cursor: interactive ? 'pointer' : 'default',
                  transition: 'fill 150ms, fill-opacity 150ms',
                }}
                onClick={(event) => runAction(event, sector.action)}
                onMouseEnter={() => setHovered(sector.action)}
                onMouseLeave={() => setHovered(null)}
              />
              {/* 扇区文字沿弧排布（上半环顺时针 / 下半环翻转，见 hub-geometry）。 */}
              <text
                pointerEvents="none"
                fontSize={12}
                fontWeight={500}
                fill={active ? '#f5f5f4' : '#e5e5e5'}
                style={{ transition: 'fill 150ms' }}
              >
                <textPath
                  href={`#hub-label-${sector.action}`}
                  startOffset="50%"
                  textAnchor="middle"
                >
                  {t(ACTION_LABEL_KEY[sector.action])}
                </textPath>
              </text>
            </g>
          )
        })}
      </svg>

      {/* 解释类结果卡片：不动原文，只展示 + 复制。 */}
      {state.status === 'result' && (
        <div
          className="absolute inset-x-5 top-1/2 z-10 -translate-y-1/2 rounded-2xl bg-neutral-900/92 p-4 shadow-xl ring-1 ring-white/10"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="text-xs font-medium text-neutral-100">{t('hub.explainTitle')}</div>
          <div className="mt-2 max-h-[150px] overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-neutral-300">
            {state.result}
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              className="rounded-full px-3 py-1 text-[11px] text-neutral-300 ring-1 ring-white/10 transition-colors hover:bg-white/10"
              onClick={copyResult}
            >
              {copied ? t('hub.copied') : t('hub.copy')}
            </button>
            <button
              type="button"
              className="rounded-full bg-primary px-3 py-1 text-[11px] text-primary-foreground transition-opacity hover:opacity-90"
              onClick={close}
            >
              {t('hub.close')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
