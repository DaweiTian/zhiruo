/**
 * 快速插入面板（`picker` 窗口）：鼠标侧键 X1/X2 唤出，点选/键盘速选注入到
 * 当前光标。
 *
 * 形态（产品定稿，见《功能方案设计.md》批次一；0.11 条目按钮）：
 * - 上下两区：常用词（置顶常用项，按本地使用计数排序）/ 最近剪贴板（最新在前）；
 * - 条目尾部动作按钮：剪贴板条目「固定」（**移动**进常用词）+「删除」，
 *   常用词条目「删除」（= 取消固定，不回填剪贴板）；
 * - 方向键 + Enter 键盘速选，Delete 删除选中项，Esc 收起（点外 / 再按侧键
 *   收起走 `mouse.rs` 钩子）；
 * - 落点：X1 默认「常用词」区、X2 默认「剪贴板」区（`focus` 来自 Rust），
 *   决定初始选中项；`both` 从头开始；
 * - 点选条目 → `picker_insert`（Rust 先还焦点给先前应用再走 `inject_text`），
 *   插入后面板收起。
 *
 * 数据流：Rust `picker-update` 事件推送 + 挂载时 `getPickerData` 拉取兜底
 * （面板首开时事件可能先于监听器到达）。使用计数存 localStorage
 * （`voicekey.picker.usage`，文本 → 次数），只影响排序，不过桥。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { toast } from 'sonner'
import { Pin, PinOff, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MAX_SNIPPET_LENGTH } from '@/shared/llm-config'
import type { PickerClipboardEntry, PickerUpdatePayload } from '@/lib/tauri-api'

const USAGE_STORAGE_KEY = 'voicekey.picker.usage'

type PickerFocus = 'snippets' | 'clipboard' | 'both'

interface FlatItem {
  /** 稳定 key：类型前缀 + 文本（常用词与剪贴板同文本不冲突）。 */
  key: string
  kind: 'snippet' | 'clipboard'
  text: string
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

export function Picker() {
  const { t } = useTranslation()
  const [snippets, setSnippets] = useState<string[]>([])
  const [clipboard, setClipboard] = useState<PickerClipboardEntry[]>([])
  const [focus, setFocus] = useState<PickerFocus>('both')
  // 用户手动选择（键盘/鼠标）；null = 用落点推导的初始选中项。每次面板打开
  // （picker-update 到达）重置回 null，跟随新落点。
  const [touchedIndex, setTouchedIndex] = useState<number | null>(null)
  // 相对时间标签的基准时刻：只在数据到达时取一次（事件回调里取当前时间，
  // 渲染期保持纯函数——react 纯度规则禁止渲染中调 Date.now）。
  const [now, setNow] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const applyPayload = useCallback((payload: PickerUpdatePayload) => {
    setSnippets(Array.isArray(payload.snippets) ? payload.snippets : [])
    setClipboard(Array.isArray(payload.clipboard) ? payload.clipboard : [])
    setNow(Date.now())
    setTouchedIndex(null)
    if (payload.focus) setFocus(toFocus(payload.focus))
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

  const flatItems = useMemo<FlatItem[]>(() => {
    const items: FlatItem[] = sortedSnippets.map((text) => ({
      key: `snippet:${text}`,
      kind: 'snippet' as const,
      text,
    }))
    clipboard.forEach((entry, index) => {
      items.push({
        // 序号兜底唯一性：时间戳 + 前缀可能撞车（同毫秒、同前 24 字符）。
        key: `clipboard:${index}:${entry.timestamp}`,
        kind: 'clipboard' as const,
        text: entry.text,
        timeLabel: timeLabel(t, entry.timestamp, now),
      })
    })
    return items
  }, [sortedSnippets, clipboard, now, t])

  // 落点决定初始选中项：X1 → 常用词第一条 / X2 → 剪贴板第一条 / both → 头一条。
  // 剪贴板落点但剪贴板为空时退回头一条（不能落到「最后一条常用词」）。
  // 用户手动移动（touchedIndex）后以手动值为准；列表收缩时夹取防越界。
  const initialIndex = focus === 'clipboard' && clipboard.length > 0 ? sortedSnippets.length : 0
  const selectedIndex =
    flatItems.length === 0 ? 0 : Math.min(touchedIndex ?? initialIndex, flatItems.length - 1)

  const insert = useCallback(
    (item: FlatItem | undefined) => {
      if (!item) return
      // Rust 侧注入成功才收起面板并计使用次数；失败保持打开可重试
      // （文本已留剪贴板）。使用计数只服务「常用词按最近使用排序」，
      // 剪贴板条目文本可能很长（单条上限 10KB），不做键。
      void window.electronAPI
        .pickerInsert(item.text)
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

  // 条目删除：剪贴板条目删历史，常用词条目即取消固定（不回填剪贴板）。
  const remove = useCallback(
    (item: FlatItem | undefined) => {
      if (!item) return
      const call =
        item.kind === 'clipboard'
          ? window.electronAPI.deleteClipboardEntry(item.text)
          : window.electronAPI.removeUserSnippet(item.text)
      void call.catch(() => toast.error(t('picker.actionFailed')))
    },
    [t],
  )

  // 键盘速选：↑/↓ 移动，Enter 注入，Delete 删除选中项，Esc 收起，Home/End 跳首尾。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
        return
      }
      if (flatItems.length === 0) return
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setTouchedIndex(Math.min(selectedIndex + 1, flatItems.length - 1))
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setTouchedIndex(Math.max(selectedIndex - 1, 0))
      } else if (event.key === 'Home') {
        event.preventDefault()
        setTouchedIndex(0)
      } else if (event.key === 'End') {
        event.preventDefault()
        setTouchedIndex(flatItems.length - 1)
      } else if (event.key === 'Enter') {
        event.preventDefault()
        insert(flatItems[Math.min(selectedIndex, flatItems.length - 1)])
      } else if (event.key === 'Delete') {
        event.preventDefault()
        remove(flatItems[Math.min(selectedIndex, flatItems.length - 1)])
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [flatItems, selectedIndex, insert, remove, close])

  // 选中项滚进可视区（两区共用一个滚动容器）。
  useEffect(() => {
    const container = listRef.current
    if (!container) return
    const selected = container.querySelector<HTMLElement>('[data-selected="true"]')
    selected?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex, flatItems.length])

  return (
    <div
      className="fixed inset-0 select-none overflow-hidden"
      onClick={close}
      onContextMenu={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <div
        className="absolute inset-2 flex flex-col overflow-hidden rounded-xl bg-popover/95 text-popover-foreground shadow-xl ring-1 ring-border"
        onClick={(event) => event.stopPropagation()}
      >
        {/* 两区共用滚动容器：常用词（置顶常用项）在上，最近剪贴板在下。 */}
        <div ref={listRef} className="flex-1 overflow-y-auto py-1.5">
          <Section
            title={t('picker.snippets')}
            count={sortedSnippets.length}
            emptyText={t('picker.emptySnippets')}
            items={flatItems.slice(0, sortedSnippets.length)}
            selectedIndex={selectedIndex}
            onSelect={setTouchedIndex}
            onInsert={insert}
            onDelete={remove}
          />
          <Section
            title={t('picker.clipboard')}
            count={clipboard.length}
            emptyText={t('picker.emptyClipboard')}
            items={flatItems.slice(sortedSnippets.length)}
            selectedIndex={selectedIndex}
            offset={sortedSnippets.length}
            onSelect={setTouchedIndex}
            onInsert={insert}
            onDelete={remove}
            onPin={pin}
            showTime
          />
        </div>
        <div className="border-t border-border/60 px-3 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
          {t('picker.hint')}
        </div>
      </div>
    </div>
  )
}

function Section({
  title,
  count,
  emptyText,
  items,
  selectedIndex,
  offset = 0,
  onSelect,
  onInsert,
  onDelete,
  onPin,
  showTime = false,
}: {
  title: string
  count: number
  emptyText: string
  items: FlatItem[]
  selectedIndex: number
  offset?: number
  onSelect: (index: number) => void
  onInsert: (item: FlatItem) => void
  onDelete: (item: FlatItem) => void
  onPin?: (item: FlatItem) => void
  showTime?: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className="px-2 pb-1">
      <div className="flex items-baseline justify-between px-1.5 pb-1 pt-1">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </span>
        {count > 0 && <span className="text-[10px] text-muted-foreground/70">{count}</span>}
      </div>
      {count === 0 ? (
        <div className="px-1.5 pb-1.5 text-[11px] leading-relaxed text-muted-foreground">
          {emptyText}
        </div>
      ) : (
        <div className="space-y-0.5">
          {items.map((item, index) => {
            const absolute = offset + index
            const selected = absolute === selectedIndex
            return (
              <div
                key={item.key}
                data-selected={selected}
                className={cn(
                  'flex w-full items-center gap-1 rounded-md pr-1 text-xs transition-colors',
                  selected
                    ? 'bg-primary/20 text-foreground ring-1 ring-primary/40'
                    : 'text-foreground/80 hover:bg-accent hover:text-foreground',
                )}
                onMouseEnter={() => onSelect(absolute)}
              >
                {/* 主体点击 = 插入；尾部动作按钮独立，不冒泡到插入。 */}
                <button
                  type="button"
                  tabIndex={-1}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left"
                  onClick={() => onInsert(item)}
                >
                  <span className="min-w-0 flex-1 truncate whitespace-pre-wrap break-words">
                    {item.text}
                  </span>
                  {showTime && item.timeLabel && (
                    <span className="shrink-0 text-[9px] text-muted-foreground">
                      {item.timeLabel}
                    </span>
                  )}
                </button>
                {onPin && (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={t('picker.pin')}
                    title={t('picker.pin')}
                    className="shrink-0 rounded-md p-1 text-muted-foreground/70 transition-colors hover:bg-primary/15 hover:text-primary"
                    onClick={() => onPin(item)}
                  >
                    <Pin className="h-3.5 w-3.5" />
                  </button>
                )}
                {/* 剪贴板条目 = 删除（Trash）；常用词条目 = 取消固定（PinOff）。 */}
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={item.kind === 'clipboard' ? t('picker.delete') : t('picker.unpin')}
                  title={item.kind === 'clipboard' ? t('picker.delete') : t('picker.unpin')}
                  className="shrink-0 rounded-md p-1 text-muted-foreground/70 transition-colors hover:bg-destructive/15 hover:text-destructive"
                  onClick={() => onDelete(item)}
                >
                  {item.kind === 'clipboard' ? (
                    <Trash2 className="h-3.5 w-3.5" />
                  ) : (
                    <PinOff className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
