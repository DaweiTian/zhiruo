import { BookOpen, Flag, Flame, Hash, Headphones, Library, Trophy, Zap } from 'lucide-react'
import type { ReactNode } from 'react'
import { DICTATION_BADGE_IDS, type DictationBadgeId } from '@/lib/stats'
import { useStatFormatters } from '@/lib/useStatFormatters'

interface BadgeGridProps {
  /** `computeBadges` 产出的全集点亮态 */
  badges: Record<DictationBadgeId, boolean>
}

const BADGE_ICONS: Record<DictationBadgeId, ReactNode> = {
  'first-dictation': <Flag className="h-4 w-4" />,
  'chars-1k': <Hash className="h-4 w-4" />,
  'chars-10k': <BookOpen className="h-4 w-4" />,
  'chars-100k': <Library className="h-4 w-4" />,
  'streak-7': <Flame className="h-4 w-4" />,
  'streak-30': <Trophy className="h-4 w-4" />,
  'day-1k': <Zap className="h-4 w-4" />,
  'audio-1h': <Headphones className="h-4 w-4" />,
}

export default function BadgeGrid({ badges }: BadgeGridProps) {
  const { t } = useStatFormatters()
  const unlockedCount = DICTATION_BADGE_IDS.filter((id) => badges[id]).length

  return (
    <section className="overflow-hidden rounded-2xl border bg-border/60">
      <div className="flex items-baseline justify-between gap-3 bg-card px-5 pb-3 pt-5">
        <h3 className="text-[11px] font-medium text-muted-foreground">
          {t('home.section.badges')}
        </h3>
        <div className="tnum text-[11px] text-muted-foreground">
          {t('home.badge.progress', {
            unlocked: unlockedCount,
            total: DICTATION_BADGE_IDS.length,
          })}
        </div>
      </div>
      <div className="mt-px grid grid-cols-2 gap-px sm:grid-cols-4">
        {DICTATION_BADGE_IDS.map((id) => {
          const unlocked = badges[id]
          return (
            <div
              key={id}
              className={`flex items-center gap-2.5 bg-card px-4 py-3.5 ${
                unlocked ? '' : 'opacity-45'
              }`}
            >
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                  unlocked ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'
                }`}
              >
                {BADGE_ICONS[id]}
              </span>
              <span
                className={`text-[11px] font-medium leading-tight ${
                  unlocked ? 'text-foreground' : 'text-muted-foreground'
                }`}
              >
                {t(`home.badge.${id}`)}
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}
