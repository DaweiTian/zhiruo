/**
 * 快速插入面板（`picker` 窗口）：鼠标侧键 X1/X2 唤出，点选/键盘速选注入到
 * 当前光标。
 *
 * 形态（产品定稿，见《docs/功能方案设计.md》批次一；0.11 条目按钮；页签化改版）：
 * - 顶部页签切换「剪贴板 / 常用词」（默认剪贴板页签，常用词页签在右）——
 *   单页签独占列表区，常用词再多也不会把剪贴板顶出可视区；常用词按本地
 *   使用计数排序、剪贴板最新在前；
 * - 条目尾部动作按钮（hover / 选中时显现）：剪贴板条目「固定」（**移动**
 *   进常用词）+「删除」，常用词条目「删除」（= 取消固定，不回填剪贴板）；
 * - ←/→ 切换页签，↑/↓ + Enter 键盘速选，Delete 删除选中项，Esc 收起
 *   （点外 / 再按侧键收起走 `mouse.rs` 钩子）；
 * - 落点：X1 默认「常用词」页签、X2 默认「剪贴板」页签（`focus` 来自 Rust），
 *   决定初始页签（目标页签为空且另一页签有货时退过去）；`both` = 默认
 *   剪贴板页签；
 * - 点选条目 → `picker_insert`（Rust 先还焦点给先前应用再走 `inject_text`），
 *   图片条目走 `picker_insert_image`（写回剪贴板 + 粘贴），插入后面板收起；
 *   图片条目以缩略图呈现（`thumb` data URL），且不出「固定」按钮（图片变
 *   不了文本常用词）。
 *
 * 动效（`index.css` `picker-*` + 打开弹入用 WAAPI）：打开时卡片做**仅 transform**
 * 的轻微弹入（不透明度恒 1——窗口 show 先于 picker-update 到达，可见后再从
 * opacity 0 播必闪一帧，0.17.0 就栽在这）；页签切换才播方向滑入 + 条目错峰
 * （`data-anim` 门禁）；均受 `prefers-reduced-motion` 门禁。
 *
 * 数据流：Rust `picker-update` 事件推送 + 挂载时 `getPickerData` 拉取兜底
 * （面板首开时事件可能先于监听器到达）。使用计数存 localStorage
 * （`voicekey.picker.usage`，文本 → 次数），只影响排序，不过桥。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { toast } from 'sonner'
import { Clipboard, Pin, PinOff, Trash2, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MAX_SNIPPET_LENGTH } from '@/shared/llm-config'
import type { PickerClipboardEntry, PickerUpdatePayload } from '@/lib/tauri-api'

const USAGE_STORAGE_KEY = 'voicekey.picker.usage'

type PickerFocus = 'snippets' | 'clipboard' | 'both'
type PickerTab = 'clipboard' | 'snippets'

interface FlatItem {
  /** 稳定 key：类型前缀 + 文本（常用词与剪贴板同文本不冲突）。 */
  key: string
  kind: 'snippet' | 'clipboard'
  text: string
  /** 条目寻址键：文本条目 = 正文，图片条目 = 文件名。删除 / 图片插入用。 */
  entryKey: string
  /** 图片条目：缩略图 data URL（缺文件时无，显示占位）。 */
  thumb?: string
  /** 图片条目标记（插入走 `pickerInsertImage`，隐藏「固定」）。 */
  isImage?: boolean
  /** 剪贴板条目的相对时间标签（常用词为 undefined）。 */
  timeLabel?: string
}

function readUsage(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(USAGE_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    // 数组也过 typeof === 'object'：必须排除，否则会放过非法形状。
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, number>)
      : {}
  } catch {
    return {}
  }
}

function bumpUsage(text: string) {
  const usage = readUsage()
  usage[text] = (usage[text] ?? 0) + 1
  try {
    window.localStorage.setItem(USAGE_STORAGE_KEY, JSON.stringify(usage))
  } catch {
    /* 存储满 / 隐私模式：排序退化为默认序，不影响功能 */
  }
}

/** 时间标签：刚刚 / N 分钟前 / N 小时前 / N 天前（超过 7 天显示日期）。 */
function timeLabel(t: TFunction, timestamp: number, now: number): string {
  const delta = Math.max(0, now - timestamp)
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return t('picker.time.now')
  if (minutes < 60) return t('picker.time.minutes', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('picker.time.hours', { n: hours })
  const days = Math.floor(hours / 24)
  if (days <= 7) return t('picker.time.days', { n: days })
  return new Date(timestamp).toLocaleDateString()
}

function toFocus(raw: unknown): PickerFocus {
  return raw === 'snippets' || raw === 'clipboard' || raw === 'both' ? raw : 'both'
}

/** 落点 → 初始页签：目标页签为空且另一页签有货时退过去，免得开出来是空页。 */
function tabForFocus(focus: PickerFocus, snippetsLen: number, clipboardLen: number): PickerTab {
  const want: PickerTab = focus === 'snippets' ? 'snippets' : 'clipboard'
  if (want === 'snippets' && snippetsLen === 0 && clipboardLen > 0) return 'clipboard'
  if (want === 'clipboard' && clipboardLen === 0 && snippetsLen > 0) return 'snippets'
  return want
}

export function Picker() {
  const { t } = useTranslation()
  const [snippets, setSnippets] = useState<string[]>([])
  const [clipboard, setClipboard] = useState<PickerClipboardEntry[]>([])
  const [activeTab, setActiveTab] = useState<PickerTab>('clipboard')
  /** 页签切换方向（`fwd` = 剪贴板 → 常用词），内容滑入方向跟着它。 */
  const [tabDir, setTabDir] = useState<'fwd' | 'back'>('fwd')
  // 用户手动选择（键盘/鼠标）；null = 用页签首条。每次面板打开
  // （picker-update 到达）重置回 null，跟随新落点。
  const [touchedIndex, setTouchedIndex] = useState<number | null>(null)
  // 打开代际（Rust `open_gen`）：变化 = 面板重新弹出，触发卡片弹入（WAAPI）；
  // 同代内的更新（删除 / 固定触发的 picker-update）不重播。
  const [openGen, setOpenGen] = useState(0)
  // 页签切换动效门禁：仅用户手动切页签播滑入；打开（applyPayload 定落点）
  // 即便换了页签也走无动效瞬切——可见后再淡入就是闪帧。
  const [tabAnim, setTabAnim] = useState(false)
  // 相对时间标签的基准时刻：只在数据到达时取一次（事件回调里取当前时间，
  // 渲染期保持纯函数——react 纯度规则禁止渲染中调 Date.now）。
  const [now, setNow] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  const applyPayload = useCallback((payload: PickerUpdatePayload) => {
    const nextSnippets = Array.isArray(payload.snippets) ? payload.snippets : []
    const nextClipboard = Array.isArray(payload.clipboard) ? payload.clipboard : []
    setSnippets(nextSnippets)
    setClipboard(nextClipboard)
    setNow(Date.now())
    setTouchedIndex(null)
    setTabAnim(false)
    if (payload.focus) {
      const focus = toFocus(payload.focus)
      setActiveTab(tabForFocus(focus, nextSnippets.length, nextClipboard.length))
      setTabDir(focus === 'snippets' ? 'fwd' : 'back')
    }
    const gen = payload.gen
    if (typeof gen === 'number') setOpenGen((prev) => (prev === gen ? prev : gen))
  }, [])

  useEffect(() => {
    // 透明窗体：撤掉 body 主题底色（同 HUD / Hub 的 overlay-html）。
    document.documentElement.classList.add('overlay-html')
    // WebView2 默认右键菜单是块黑底矩形面板——抑制掉。
    const preventContextMenu = (event: Event) => event.preventDefault()
    window.addEventListener('contextmenu', preventContextMenu)

    const unsub = window.electronAPI.onPickerUpdate(applyPayload)
    // `picker-update` 可能先于本监听器到达（面板首开竞态）：拉一份兜底。
    void window.electronAPI
      .getPickerData()
      .then(applyPayload)
      .catch(() => {
        /* 面板数据不可用时保持空列表 */
      })
    return () => {
      unsub()
      window.removeEventListener('contextmenu', preventContextMenu)
      document.documentElement.classList.remove('overlay-html')
    }
  }, [applyPayload])

  // 常用词按本地使用次数降序（无使用记录保持配置序）；最近剪贴板保持时间序。
  const sortedSnippets = useMemo(() => {
    const usage = readUsage()
    return [...snippets].sort((a, b) => (usage[b] ?? 0) - (usage[a] ?? 0))
  }, [snippets])

  const snippetItems = useMemo<FlatItem[]>(
    () =>
      sortedSnippets.map((text) => ({
        key: `snippet:${text}`,
        kind: 'snippet' as const,
        text,
        entryKey: text,
      })),
    [sortedSnippets],
  )

  const clipboardItems = useMemo<FlatItem[]>(
    () =>
      clipboard.map((entry, index) => {
        const isImage = entry.kind === 'image' || Boolean(entry.image)
        return {
          // 序号兜底唯一性：时间戳 + 前缀可能撞车（同毫秒、同前 24 字符）。
          key: `clipboard:${index}:${entry.timestamp}`,
          kind: 'clipboard' as const,
          // 图片条目正文为空串：显示标签替身（缩略图才是主体）。
          text: isImage ? t('picker.imageEntry') : entry.text,
          entryKey: isImage ? (entry.image ?? '') : entry.text,
          thumb: entry.thumb,
          isImage,
          timeLabel: timeLabel(t, entry.timestamp, now),
        }
      }),
    [clipboard, now, t],
  )

  const items = activeTab === 'clipboard' ? clipboardItems : snippetItems
  // 用户手动移动（touchedIndex）后以手动值为准；列表收缩时夹取防越界。
  const selectedIndex = items.length === 0 ? 0 : Math.min(touchedIndex ?? 0, items.length - 1)

  const switchTab = useCallback(
    (tab: PickerTab) => {
      if (tab === activeTab) return
      setTabDir(tab === 'snippets' ? 'fwd' : 'back')
      setTabAnim(true)
      setActiveTab(tab)
      setTouchedIndex(null)
    },
    [activeTab],
  )

  // 打开反馈：卡片做仅 transform 的轻微弹入。绝不动 opacity——窗口 show 先于
  // picker-update 到达，面板此刻已可见，从透明度 0 重播必闪一帧（0.17.0 教训）。
  useEffect(() => {
    if (openGen === 0) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    cardRef.current?.animate(
      [{ transform: 'translateY(5px) scale(0.985)' }, { transform: 'translateY(0) scale(1)' }],
      { duration: 150, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
    )
  }, [openGen])

  const insert = useCallback(
    (item: FlatItem | undefined) => {
      if (!item) return
      // Rust 侧注入成功才收起面板并计使用次数；失败保持打开可重试
      // （内容已留剪贴板）。使用计数只服务「常用词按最近使用排序」，
      // 剪贴板条目文本可能很长（单条上限 10KB），不做键。
      const call =
        item.kind === 'clipboard' && item.isImage
          ? window.electronAPI.pickerInsertImage(item.entryKey)
          : window.electronAPI.pickerInsert(item.text)
      void call
        .then(() => {
          if (item.kind === 'snippet') bumpUsage(item.text)
        })
        .catch(() => {
          toast.error(t('picker.insertFailed'))
        })
    },
    [t],
  )

  const close = useCallback(() => {
    void window.electronAPI.closePickerPanel().catch(() => {})
  }, [])

  // 面板宽度拖拽（右缘把手）：拖动中实时调宽（只调形不落盘），松手把最终
  // 宽度持久化到 `picker.panelWidth`（Rust 夹取 240–720，返回生效值）。
  // 指针捕获保证拖出窗口（如拖向副屏）仍能收到 move/up；捕获事件冒泡到
  // window 监听器，与「没捕获上但指针仍在窗口内」走同一处理器。
  const beginResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startW = window.innerWidth
    event.currentTarget.setPointerCapture(event.pointerId)
    const widthAt = (ev: PointerEvent) => startW + (ev.clientX - startX)
    const onMove = (ev: PointerEvent) => {
      void window.electronAPI.setPickerWidth(widthAt(ev), false)
    }
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      void window.electronAPI.setPickerWidth(widthAt(ev), true)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  // 剪贴板条目「固定」：移动进常用词（Rust 侧移出剪贴板历史）。
  // 长度 / 容量在前端预检给本地化提示；Rust 再兜一层 invoke 边界校验。
  const pin = useCallback(
    (item: FlatItem | undefined) => {
      if (!item) return
      const trimmed = item.text.trim()
      // 与 Rust `chars().count()` 同口径（码点数），emoji 不被误拒。
      if ([...trimmed].length > MAX_SNIPPET_LENGTH) {
        toast.error(t('picker.pinTooLong'))
        return
      }
      if (!snippets.includes(trimmed) && snippets.length >= 100) {
        toast.error(t('picker.pinFull'))
        return
      }
      void window.electronAPI
        .pinClipboardEntry(item.text)
        .then(() => toast.success(t('picker.pinned')))
        .catch(() => toast.error(t('picker.actionFailed')))
    },
    [snippets, t],
  )

  // 条目删除：剪贴板条目删历史（按条目键寻址），常用词条目即取消固定
  // （不回填剪贴板）。
  const remove = useCallback(
    (item: FlatItem | undefined) => {
      if (!item) return
      const call =
        item.kind === 'clipboard'
          ? window.electronAPI.deleteClipboardEntry(item.entryKey)
          : window.electronAPI.removeUserSnippet(item.text)
      void call.catch(() => toast.error(t('picker.actionFailed')))
    },
    [t],
  )

  // 键盘速选：←/→ 切换页签，↑/↓ 移动，Enter 注入，Delete 删除选中项，
  // Esc 收起，Home/End 跳首尾。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
        return
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        switchTab(activeTab === 'clipboard' ? 'snippets' : 'clipboard')
        return
      }
      if (items.length === 0) return
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setTouchedIndex(Math.min(selectedIndex + 1, items.length - 1))
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setTouchedIndex(Math.max(selectedIndex - 1, 0))
      } else if (event.key === 'Home') {
        event.preventDefault()
        setTouchedIndex(0)
      } else if (event.key === 'End') {
        event.preventDefault()
        setTouchedIndex(items.length - 1)
      } else if (event.key === 'Enter') {
        event.preventDefault()
        insert(items[Math.min(selectedIndex, items.length - 1)])
      } else if (event.key === 'Delete') {
        event.preventDefault()
        remove(items[Math.min(selectedIndex, items.length - 1)])
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [items, selectedIndex, insert, remove, close, switchTab, activeTab])

  // 选中项滚进可视区（单页签一个滚动容器）。
  useEffect(() => {
    const container = listRef.current
    if (!container) return
    const selected = container.querySelector<HTMLElement>('[data-selected="true"]')
    selected?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex, items.length, activeTab])

  return (
    <div
      className="fixed inset-0 select-none overflow-hidden"
      onClick={close}
      onContextMenu={(event) => {
        event.preventDefault()
        close()
      }}
    >
      {/* 右缘拖拽把手：调整面板宽度。独立于面板卡片之外的窗缘空白带，
          点击/右键不冒泡到收起。 */}
      <div
        className="absolute inset-y-0 right-0 flex w-2.5 cursor-ew-resize items-center justify-center"
        title={t('picker.resizeHint')}
        onPointerDown={beginResize}
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
      >
        <span className="h-8 w-px rounded-full bg-border/70" />
      </div>
      {/* 卡片本体不随打开重挂——重挂会把入场动画重播到已可见的窗口上（闪帧）。 */}
      <div
        ref={cardRef}
        className="absolute inset-2 flex flex-col overflow-hidden rounded-xl bg-popover/95 text-popover-foreground shadow-xl ring-1 ring-border backdrop-blur-md"
        onClick={(event) => event.stopPropagation()}
      >
        {/* 页签栏：段控样式，滑块跟随切换；条目数进角标（不再占列表区标题行）。 */}
        <div className="flex items-center gap-2 px-2.5 pb-1.5 pt-2.5">
          <div className="relative flex flex-1 rounded-lg bg-muted/60 p-1">
            <span
              aria-hidden
              className={cn(
                'picker-tab-pill absolute bottom-1 left-1 top-1 w-[calc(50%-0.25rem)]',
                'rounded-md bg-background shadow-sm ring-1 ring-border/50',
              )}
              style={{
                transform: activeTab === 'snippets' ? 'translateX(100%)' : 'translateX(0)',
              }}
            />
            <TabButton
              label={t('picker.tabClipboard')}
              count={clipboard.length}
              active={activeTab === 'clipboard'}
              onClick={() => switchTab('clipboard')}
            />
            <TabButton
              label={t('picker.tabSnippets')}
              count={snippets.length}
              active={activeTab === 'snippets'}
              onClick={() => switchTab('snippets')}
            />
          </div>
        </div>
        {/* 内容区：key = 页签；滑入 + 条目错峰仅在手动切页签（data-anim）时播。 */}
        <div
          key={activeTab}
          ref={listRef}
          data-dir={tabDir}
          data-anim={tabAnim ? 'on' : 'off'}
          className="picker-tab-in flex-1 overflow-y-auto px-2 py-1.5"
        >
          {items.length === 0 ? (
            <EmptyState
              icon={activeTab === 'clipboard' ? Clipboard : Pin}
              text={
                activeTab === 'clipboard' ? t('picker.emptyClipboard') : t('picker.emptySnippets')
              }
            />
          ) : (
            <div className="space-y-0.5">
              {items.map((item, index) => (
                <ItemRow
                  key={item.key}
                  item={item}
                  index={index}
                  delayMs={Math.min(index * 28, 280)}
                  selected={index === selectedIndex}
                  showTime={activeTab === 'clipboard'}
                  onPin={activeTab === 'clipboard' ? pin : undefined}
                  onSelect={setTouchedIndex}
                  onInsert={insert}
                  onDelete={remove}
                />
              ))}
            </div>
          )}
        </div>
        <div className="border-t border-border/60 px-3 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
          {t('picker.hint')}
        </div>
      </div>
    </div>
  )
}

function TabButton({
  label,
  count,
  active,
  onClick,
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      onClick={onClick}
      className={cn(
        'relative z-10 flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1',
        'text-[11px] font-medium transition-colors duration-200',
        active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      <span>{label}</span>
      {count > 0 && (
        <span
          className={cn(
            'rounded-full px-1.5 py-px text-[9px] font-normal leading-[1.4] tabular-nums',
            active ? 'bg-primary/15 text-primary' : 'bg-muted-foreground/15 text-muted-foreground',
          )}
        >
          {count}
        </span>
      )}
    </button>
  )
}

function EmptyState({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <div className="flex flex-col items-center gap-2.5 px-4 pb-6 pt-10 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-muted/70 text-muted-foreground/60">
        <Icon className="h-5 w-5" strokeWidth={1.5} />
      </div>
      <p className="max-w-[15rem] text-[11px] leading-relaxed text-muted-foreground">{text}</p>
    </div>
  )
}

function ItemRow({
  item,
  index,
  delayMs,
  selected,
  showTime,
  onPin,
  onSelect,
  onInsert,
  onDelete,
}: {
  item: FlatItem
  index: number
  delayMs: number
  selected: boolean
  showTime: boolean
  onPin?: (item: FlatItem) => void
  onSelect: (index: number) => void
  onInsert: (item: FlatItem) => void
  onDelete: (item: FlatItem) => void
}) {
  const { t } = useTranslation()
  return (
    <div
      data-selected={selected}
      style={{ animationDelay: `${delayMs}ms` }}
      className={cn(
        'picker-item-in group flex w-full items-center gap-1 rounded-lg pr-1 text-xs',
        'transition-colors duration-150',
        selected
          ? 'bg-primary/15 text-foreground ring-1 ring-primary/35'
          : 'text-foreground/80 hover:bg-accent/60 hover:text-foreground',
      )}
      onMouseEnter={() => onSelect(index)}
    >
      {/* 主体点击 = 插入；尾部动作按钮独立，不冒泡到插入。 */}
      <button
        type="button"
        tabIndex={-1}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left"
        onClick={() => onInsert(item)}
      >
        {item.isImage && (
          <span className="flex h-9 w-12 shrink-0 items-center justify-center overflow-hidden rounded bg-muted ring-1 ring-border/60">
            {item.thumb ? (
              <img
                src={item.thumb}
                alt=""
                className="h-full w-full object-cover"
                draggable={false}
              />
            ) : (
              <span className="text-[9px] leading-none text-muted-foreground">
                {t('picker.imageEntry')}
              </span>
            )}
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
          <span className="w-full min-w-0 truncate whitespace-pre-wrap break-words">
            {item.text}
          </span>
          {/* 时间标签在条目底部自成一行——挂右侧太挤正文宽度（0.15.x）。 */}
          {showTime && item.timeLabel && (
            <span className="text-[9px] leading-none text-muted-foreground">{item.timeLabel}</span>
          )}
        </span>
      </button>
      {/* 动作按钮纵向排列（0.12 用户拍板）：两枚小图标上下叠，少挤正文宽度。
          hover / 选中时淡入——常显太抢正文。剪贴板条目 = 固定（上）+ 删除（下）；
          常用词条目 = 取消固定。图片条目不能变文本常用词，只留删除。 */}
      <div
        className={cn(
          'flex shrink-0 flex-col gap-0.5 opacity-0 transition-opacity duration-150',
          'group-hover:opacity-100',
          selected && 'opacity-100',
        )}
      >
        {onPin && !item.isImage && (
          <button
            type="button"
            tabIndex={-1}
            aria-label={t('picker.pin')}
            title={t('picker.pin')}
            className="rounded-md p-0.5 text-muted-foreground/70 transition-colors hover:bg-primary/15 hover:text-primary"
            onClick={() => onPin(item)}
          >
            <Pin className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          tabIndex={-1}
          aria-label={item.kind === 'clipboard' ? t('picker.delete') : t('picker.unpin')}
          title={item.kind === 'clipboard' ? t('picker.delete') : t('picker.unpin')}
          className="rounded-md p-0.5 text-muted-foreground/70 transition-colors hover:bg-destructive/15 hover:text-destructive"
          onClick={() => onDelete(item)}
        >
          {item.kind === 'clipboard' ? (
            <Trash2 className="h-3.5 w-3.5" />
          ) : (
            <PinOff className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
    </div>
  )
}
