import { useMemo } from 'react'
import type { DictationStats } from '@/lib/stats'
import { useStatFormatters } from '@/lib/useStatFormatters'

interface HourHeatmapProps {
  /** 本地小时 0..23 -> 累计字符数（`computeStats` 产出，长度恒为 24） */
  hourly: DictationStats['hourly']
}

const HOUR_COUNT = 24

/** 五档色阶（Tailwind 静态类名，避开内联色值）；0 值走 muted 底。 */
function heatClass(value: number, max: number): string {
  if (max <= 0 || value <= 0) return 'bg-muted/60'
  const ratio = value / max
  if (ratio <= 0.25) return 'bg-primary/15'
  if (ratio <= 0.5) return 'bg-primary/30'
  if (ratio <= 0.75) return 'bg-primary/50'
  return 'bg-primary/80'
}

const padHour = (hour: number): string => String(hour).padStart(2, '0')

export default function HourHeatmap({ hourly }: HourHeatmapProps) {
  const { t, formatNumber } = useStatFormatters()

  const { max, peakHour, peakValue } = useMemo(() => {
    let max = 0
    let peakHour = -1
    let peakValue = 0
    hourly.forEach((value, hour) => {
      if (value > max) max = value
      if (value > peakValue) {
        peakValue = value
        peakHour = hour
      }
    })
    return { max, peakHour, peakValue }
  }, [hourly])

  const peakRange =
    peakHour >= 0 ? `${padHour(peakHour)}:00–${padHour((peakHour + 1) % HOUR_COUNT)}:00` : ''

  return (
    <section className="rounded-2xl border bg-card px-5 py-5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[11px] font-medium text-muted-foreground">
          {t('home.section.activity')}
        </h3>
        <div className="tnum text-[11px] text-muted-foreground">
          {peakHour >= 0 ? (
            <span>
              {t('home.heatmap.mostActive', {
                range: peakRange,
                value: formatNumber(peakValue),
              })}
            </span>
          ) : (
            t('home.heatmap.noActivity')
          )}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-12 gap-px">
        {hourly.map((value, hour) => (
          <div
            key={hour}
            title={`${padHour(hour)}:00 · ${formatNumber(value)}`}
            className={`flex h-9 items-end justify-center rounded-[4px] ${heatClass(value, max)} ${
              hour === peakHour && peakValue > 0 ? 'ring-1 ring-inset ring-primary' : ''
            }`}
          >
            <span
              className={`pb-0.5 text-[9px] leading-none ${
                value > 0 && value / max > 0.5
                  ? 'text-primary-foreground/90'
                  : 'text-muted-foreground'
              }`}
            >
              {hour}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}
