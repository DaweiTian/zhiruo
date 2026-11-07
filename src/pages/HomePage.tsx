import { ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Mic, Hash, Clock, TrendingUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { VoiceWave } from '@/components/VoiceWave'
import { HotkeyKeys } from '@/components/HotkeyKeys'
import StatsOverview from '@/components/StatsOverview'
import InteractiveCharts from '@/components/InteractiveCharts'
import { computeStats, type HistoryItem, type StoredDictationStats } from '@/lib/stats'
import { useStatFormatters } from '@/lib/useStatFormatters'

function greetingKey(): string {
  const hour = new Date().getHours()
  if (hour < 6) return 'night'
  if (hour < 12) return 'morning'
  if (hour < 18) return 'afternoon'
  return 'evening'
}

/**
 * Hero 数字的计数动画：从上一次显示值缓动到最新值（首屏从 0 起）。
 * 尊重 `prefers-reduced-motion`（跳过缓动、单帧落位）；卸载/中断不产生多余渲染。
 */
function useCountUp(target: number, duration = 700): number {
  const [display, setDisplay] = useState(0)
  const displayRef = useRef(0)

  useEffect(() => {
    const from = displayRef.current
    if (from === target) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let raf = 0
    const start = performance.now()
    const tick = (now: number) => {
      const p = reduce ? 1 : Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - p, 3)
      const next = Math.round(from + (target - from) * eased)
      displayRef.current = next
      setDisplay(next)
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      // 只取消帧，不动 displayRef：tick 已维护它为「当前显示值」，
      // 目标变化时新动画从此值接续，数字不跳变。
      cancelAnimationFrame(raf)
    }
  }, [target, duration])

  return display
}

/** 计数动画的叶子组件：每帧 setState 只重渲自身，不牵动整页（含 recharts 图表）。 */
function AnimatedCount({ target }: { target: number }) {
  const { formatNumber } = useStatFormatters()
  return <>{formatNumber(useCountUp(target))}</>
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
      <span className="h-1.5 w-1.5 rounded-full bg-primary" />
      {children}
    </div>
  )
}

function MiniStat({ icon, value, label }: { icon: ReactNode; value: string; label: string }) {
  return (
    <div className="flex flex-col justify-center gap-1.5 bg-card px-5 py-4">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <span className="text-primary/70">{icon}</span>
        {label}
      </div>
      <div className="tnum font-display text-[19px] font-semibold tracking-tight text-foreground">
        {value}
      </div>
    </div>
  )
}

export default function HomePage() {
  const { t } = useTranslation()
  const { formatNumber, formatDuration } = useStatFormatters()
  const [pttKey, setPttKey] = useState('')
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([])
  const [storedStats, setStoredStats] = useState<StoredDictationStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    window.electronAPI
      .getConfig()
      .then((config) => setPttKey(config?.hotkey?.pttKey ?? ''))
      .catch((error) => console.error('Failed to load config:', error))
  }, [])

  useEffect(() => {
    let active = true
    // 请求序守卫：并发 reload（转写事件触发）时旧响应不得覆盖新数据
    let requestSeq = 0
    const loadData = async (showLoading = true) => {
      const seq = ++requestSeq
      try {
        if (showLoading) setLoading(true)
        // 历史与累计统计并行取数；getStats 失败时保留 null，降级为纯历史聚合
        const [data, stored] = await Promise.all([
          window.electronAPI.getHistory(),
          window.electronAPI.getStats().catch((error) => {
            console.error('Failed to load stored stats:', error)
            return null
          }),
        ])
        if (active && seq === requestSeq) {
          setHistoryItems(data)
          setStoredStats(stored)
        }
      } catch (error) {
        console.error('Failed to load history:', error)
      } finally {
        if (active && showLoading) setLoading(false)
      }
    }
    loadData()
    // Refresh stats whenever a transcription completes (event emitted by Rust).
    const unsub = window.electronAPI.onTranscription(() => {
      loadData(false)
    })
    return () => {
      active = false
      unsub()
    }
  }, [])

  const stats = useMemo(() => computeStats(historyItems, storedStats), [historyItems, storedStats])
  const isMac = window.electronAPI.platform === 'darwin'
  const effectivePtt = pttKey || (isMac ? 'Alt' : 'Control+Shift+Space')

  return (
    <div className="mx-auto max-w-[980px] px-5 py-8 lg:px-8">
      {/* 页头 */}
      <header className="vk-rise">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
          <Mic className="h-3 w-3" />
          {t('home.eyebrow')}
        </span>
        <h1 className="mt-2 font-display text-[28px] font-bold tracking-tight text-foreground">
          {t(`home.greeting.${greetingKey()}`)}
        </h1>
        <p className="mt-1.5 flex items-center gap-2 text-[13px] text-muted-foreground">
          {t('home.subtitle')}
          {loading && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />}
        </p>
      </header>

      {/* 语音控制台 */}
      <section className="vk-rise relative mt-6 overflow-hidden rounded-2xl border bg-card shadow-sm">
        <div className="pointer-events-none absolute -top-20 right-[8%] h-52 w-80 rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklch,var(--primary)_16%,transparent),transparent)]" />
        <div className="relative flex flex-wrap items-center gap-x-5 gap-y-4 px-5 py-5 lg:px-6">
          <div className="relative grid h-12 w-12 shrink-0 place-items-center rounded-full border border-primary/30 bg-primary/10 text-primary">
            <Mic className="h-5 w-5" />
          </div>
          <div className="min-w-[150px] flex-1">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-primary">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
              {t('home.hero.standby')}
            </div>
            <h2 className="mt-1 text-[15px] font-semibold text-foreground">
              {t('home.hero.holdToTalk')}
            </h2>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {t('home.hero.holdHint')}
            </p>
          </div>
          <div className="ml-auto flex w-full flex-wrap items-center gap-x-4 gap-y-3 sm:w-auto">
            <div className="shrink-0 rounded-xl border bg-secondary/50 px-3 py-2.5">
              <HotkeyKeys value={effectivePtt} />
            </div>
            <div className="h-9 w-[150px] shrink-0 text-primary/70">
              <VoiceWave bars={30} active level={0.6} />
            </div>
          </div>
        </div>
      </section>

      {/* 今日 */}
      <div className="vk-rise mt-7" style={{ animationDelay: '70ms' }}>
        <SectionLabel>{t('home.section.today')}</SectionLabel>
        <div className="mt-3 overflow-hidden rounded-2xl border bg-border/60">
          <div className="grid gap-px md:grid-cols-[1.25fr_1.35fr]">
            {/* 英雄数字：今日字数 */}
            <div className="flex flex-col justify-center bg-card px-5 py-6 lg:px-6">
              <div className="flex items-center gap-2 text-[11px] font-semibold text-muted-foreground">
                {t('home.stats.todayCharacters')}
                <span className="h-px w-8 rounded-full bg-primary/70" />
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="tnum font-display text-[46px] font-bold leading-none tracking-tight text-foreground sm:text-[56px]">
                  <AnimatedCount target={stats.todayCharacters} />
                </span>
                <span className="text-[17px] font-semibold text-muted-foreground">
                  {t('home.charUnit')}
                </span>
              </div>
            </div>
            {/* 今日次级指标 */}
            <div className="grid grid-cols-3 gap-px bg-border/60">
              <MiniStat
                icon={<Hash className="h-3 w-3" />}
                value={formatNumber(stats.todaySessions)}
                label={t('home.stats.todaySessions')}
              />
              <MiniStat
                icon={<Clock className="h-3 w-3" />}
                value={formatDuration(stats.todayDuration)}
                label={t('home.stats.todayDuration')}
              />
              <MiniStat
                icon={<TrendingUp className="h-3 w-3" />}
                value={formatNumber(stats.recentCharacters)}
                label={t('home.recent7')}
              />
            </div>
          </div>
        </div>
      </div>

      {/* 累计 */}
      <div className="vk-rise mt-7" style={{ animationDelay: '140ms' }}>
        <SectionLabel>{t('home.section.total')}</SectionLabel>
        <div className="mt-3">
          <StatsOverview stats={stats} />
        </div>
      </div>

      {/* 趋势 */}
      <div className="vk-rise mt-7 pb-2" style={{ animationDelay: '210ms' }}>
        <InteractiveCharts historyItems={historyItems} loading={loading} />
      </div>
    </div>
  )
}
