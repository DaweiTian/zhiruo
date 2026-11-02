import { ReactNode } from 'react'
import { Type, Volume2, CalendarDays, TrendingUp } from 'lucide-react'
import type { DictationStats } from '@/lib/stats'
import { useStatFormatters } from '@/lib/useStatFormatters'

interface StatsOverviewProps {
  /** 已合并 Rust 独立累计统计的概览（`@/lib/stats::computeStats` 产出） */
  stats: DictationStats
}

const rangeDays = 7

function StatCell({
  icon,
  label,
  value,
  sub,
}: {
  icon: ReactNode
  label: string
  value: string
  sub?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-2 bg-card px-5 py-5">
      <div className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
        <span className="text-primary/70">{icon}</span>
        {label}
      </div>
      <div className="tnum font-display text-[24px] font-bold tracking-tight text-foreground">
        {value}
      </div>
      {sub ? <div className="mt-auto text-[11px] text-muted-foreground">{sub}</div> : null}
    </div>
  )
}

export default function StatsOverview({ stats }: StatsOverviewProps) {
  const { t, formatNumber, formatDuration, formatPeakDay } = useStatFormatters()
  const rangeLabel = t('home.range.label', { count: rangeDays })

  return (
    <section className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border bg-border/60 md:grid-cols-4">
      <StatCell
        icon={<Type className="h-3.5 w-3.5" />}
        label={t('home.stats.totalCharacters')}
        value={formatNumber(stats.totalCharacters)}
        sub={
          <span>
            {rangeLabel}{' '}
            <span className="font-semibold text-green-600 dark:text-green-500">
              +{formatNumber(stats.recentCharacters)}
            </span>
          </span>
        }
      />
      <StatCell
        icon={<Volume2 className="h-3.5 w-3.5" />}
        label={t('home.stats.totalAudio')}
        value={formatDuration(stats.totalAudioMs)}
        sub={
          // 有识别内容但从未记录过时长（老记录无 duration）时显示 —
          stats.totalAudioMs === 0 && stats.totalCharacters > 0
            ? '—'
            : `${rangeLabel} +${formatDuration(stats.recentAudioMs)}`
        }
      />
      <StatCell
        icon={<CalendarDays className="h-3.5 w-3.5" />}
        label={t('home.stats.activeDays')}
        value={formatNumber(stats.activeDays)}
        sub={t('home.stats.activeDaysHint')}
      />
      <StatCell
        icon={<TrendingUp className="h-3.5 w-3.5" />}
        label={t('home.stats.peakDay')}
        value={stats.peakDayCharacters > 0 ? formatNumber(stats.peakDayCharacters) : '—'}
        sub={
          stats.peakDayCharacters > 0
            ? t('home.stats.peakDayValue', {
                date: formatPeakDay(stats.peakDayKey),
                value: formatNumber(stats.peakDayCharacters),
              })
            : t('home.summary.noActivity')
        }
      />
    </section>
  )
}
