/**
 * 选区快捷动作 hub（`hub` 窗口）：右键常驻胶囊弹出的圆环动作面板。
 *
 * 形态（产品定稿，几何见 `lib/hub-geometry.ts`）：
 * - 自由悬浮：完整圆环均分扇区围绕胶囊（胶囊是 overlay 窗口，透过本窗中孔可见）；
 * - 贴靠屏幕边缘：只朝屏幕内展开半环（`dockEdge` 来自 Rust `hub-update`）。
 *
 * 窗口透明（`html.overlay-html` 撤掉 body 底色）：只画圆弧扇区与其上的
 * 浮动信息，扇区半透明（下方内容透得出来），不再压一块纯色黑底。
 * 窗口整只钳在屏幕工作区内、圆环不居中——`ringCenter`（环心相对窗口的
 * 偏移）把圆环 SVG 平移到胶囊中心，状态文字 / 结果卡片因此贴边时
 * 也完整可见；环心偏上时文字翻到窗口下半，绝不压扇区。
 * 贴边判定 = config `dockEdge`，未吸附但环心距窗口边不足外半径时由
 * `edgeFromRingCenter` 兜底推导（贴近屏幕边缘同样只展开朝屏幕内的半环）。
 *
 * 状态流由 Rust `hub-update` 驱动：capturing → ready / empty / error →
 * processing → done（改写类，稍后自动收起）/ result（解释类，展示卡片）。
 * 收起：点扇区外任意处 / 右键 / 结果卡片关闭按钮 / Windows 全局钩子的
 * 点外点击（`mouse.rs`）。扇区文字沿弧排布（`textPath`），展开动画见
 * index.css `.hub-sector-in`，hover 动效见 `.hub-sector`。
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  buildHubSectors,
  edgeFromRingCenter,
  HUB_RING_CENTER,
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
  /** 环心相对窗口左上角的偏移（CSS px）；见 `HubUpdatePayload.ringCenter`。 */
  ringCenter: { x: number; y: number }
  preview: string
  result: string
  message: string
}

function toDockEdge(value: unknown): HubDockEdge | null {
  return value === 'left' || value === 'right' || value === 'top' || value === 'bottom'
    ? value
    : null
}

/** 命令边界不可信：非有限值回退窗口正中（无偏移摆位的默认环心）。 */
function toRingCenter(value: unknown): { x: number; y: number } {
  const point = value as { x?: unknown; y?: unknown } | null | undefined
  const x = typeof point?.x === 'number' && Number.isFinite(point.x) ? point.x : HUB_RING_CENTER
  const y = typeof point?.y === 'number' && Number.isFinite(point.y) ? point.y : HUB_RING_CENTER
  return { x, y }
}

function readPayload(payload: HubUpdatePayload): HubState {
  return {
    status: payload.status ?? 'capturing',
    dockEdge: toDockEdge(payload.dockEdge),
    ringCenter: toRingCenter(payload.ringCenter),
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
    ringCenter: { x: HUB_RING_CENTER, y: HUB_RING_CENTER },
    preview: '',
    result: '',
    message: '',
  })
  const [copied, setCopied] = useState(false)
  const copiedResetTimerRef = useRef(0)

  useEffect(() => {
    // 透明窗体：撤掉 body 主题底色，只剩扇区 / 浮动信息（同 HUD 的 overlay-html）。
    document.documentElement.classList.add('overlay-html')
    // WebView2 默认右键菜单是块黑底矩形面板——抑制掉；右键 = 收起（toggle 手势）。
    const preventContextMenu = (event: Event) => event.preventDefault()
    window.addEventListener('contextmenu', preventContextMenu)
    const unsub = window.electronAPI.onHubUpdate((payload) => {
      setState(readPayload(payload))
    })
    return () => {
      unsub()
      window.removeEventListener('contextmenu', preventContextMenu)
      window.clearTimeout(copiedResetTimerRef.current)
      document.documentElement.classList.remove('overlay-html')
    }
  }, [])

  // 只有 ready 态扇区可点；capturing / empty / processing / done / result 只读。
  const interactive = state.status === 'ready'
  const ringDimmed = state.status === 'processing' || state.status === 'done'

  // 贴边判定：吸附态（config dockEdge）优先；未吸附但环心距窗口边不足外半径
  // （贴近屏幕边缘）由几何推导兜底——全环会被窗口裁缺，同样只展开半环。
  const dockEdge = useMemo(
    () => state.dockEdge ?? edgeFromRingCenter(state.ringCenter),
    [state.dockEdge, state.ringCenter],
  )
  const sectors = useMemo(() => buildHubSectors(dockEdge), [dockEdge])

  // 浮动信息贴窗口哪条横边：环心偏上（贴上边 / 贴近屏幕上沿）时翻到下半，
  // 避免文字压在扇区上；其余情况保持上沿（自由悬浮的定稿形态）。
  const infoAtBottom = state.ringCenter.y < HUB_RING_CENTER

  const close = () => {
    void window.electronAPI.closeSelectionHub().catch(() => {})
  }

  const runAction = (event: ReactMouseEvent, action: HubAction) => {
    event.stopPropagation()
    if (!interactive) return
    void window.electronAPI.runSelectionHubAction(action).catch(() => {})
  }

  const copyResult = (event: ReactMouseEvent) => {
    event.stopPropagation()
    if (!state.result) return
    void window.electronAPI
      .copyText(state.result)
      .then(() => {
        setCopied(true)
        window.clearTimeout(copiedResetTimerRef.current)
        copiedResetTimerRef.current = window.setTimeout(() => setCopied(false), 1200)
      })
      .catch(() => {
        console.warn('[Renderer] Hub copy failed')
      })
  }

  const statusText = (() => {
    switch (state.status) {
      case 'capturing':
        return t('hub.capturing')
      // empty：无选区时圆环已只读，不再显示「未检测到选区」字样（用户拍板）。
      case 'empty':
        return ''
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
    // 背景点击 / 右键 = 收起。扇区 / 结果卡片各自 stopPropagation，不冒泡到此。
    <div
      className="fixed inset-0 select-none overflow-hidden"
      onClick={close}
      onContextMenu={(event) => {
        event.preventDefault()
        close()
      }}
    >
      {/* 浮动信息（top / bottom 自适应）：capturing / processing /
          done / error 状态文字与 ready 选区预览（empty 不显示文字）。环心偏上时翻到窗口下半——
          窗口整只在屏内，文字换行而非截断，贴边也完整可读。 */}
      <div
        className={cn(
          'pointer-events-none absolute inset-x-0 flex justify-center px-4',
          infoAtBottom ? 'bottom-4' : 'top-4',
        )}
      >
        {statusText && (
          <div
            className={cn(
              'max-w-full whitespace-normal break-words rounded-2xl px-3 py-1 text-center text-[11px] leading-snug ring-1',
              state.status === 'error'
                ? 'bg-red-950/80 text-red-200 ring-red-400/25'
                : 'bg-neutral-900/85 text-neutral-300 ring-white/10',
            )}
          >
            {statusText}
          </div>
        )}
        {/* ready：选区预览一行（截断），提示动作对象。 */}
        {state.status === 'ready' && state.preview && (
          <div className="max-w-full truncate rounded-full bg-neutral-900/70 px-3 py-1 text-[10px] text-neutral-400 ring-1 ring-white/[0.06]">
            {state.preview}
          </div>
        )}
      </div>

      {/* 圆环：viewBox 恒等于窗口坐标系，SVG 整体偏移把环心钉回胶囊中心
          （窗口钳入工作区后不再居中）；中孔透明露出下层胶囊。 */}
      <svg
        viewBox={`0 0 ${HUB_VIEW_SIZE} ${HUB_VIEW_SIZE}`}
        className={cn(
          'absolute h-full w-full transition-opacity duration-200',
          ringDimmed && 'opacity-40',
        )}
        style={{
          left: state.ringCenter.x - HUB_RING_CENTER,
          top: state.ringCenter.y - HUB_RING_CENTER,
        }}
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
        {sectors.map((sector, index) => (
          <g
            key={sector.action}
            className="hub-sector-in"
            style={{
              animationDelay: `${index * 45}ms`,
              pointerEvents: interactive ? 'auto' : 'none',
            }}
          >
            {/* hover 动效层（index.css .hub-sector）：放大弹出 + 主色提亮 + 辉光。 */}
            <g className="hub-sector">
              <path
                className="hub-sector-fill"
                d={sector.fillPath}
                style={{ cursor: interactive ? 'pointer' : 'default' }}
                onClick={(event) => runAction(event, sector.action)}
              />
              {/* 扇区文字沿弧排布（上半环顺时针 / 下半环翻转，见 hub-geometry）。 */}
              <text
                className="hub-sector-label"
                pointerEvents="none"
                fontSize={12}
                fontWeight={500}
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
          </g>
        ))}
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
