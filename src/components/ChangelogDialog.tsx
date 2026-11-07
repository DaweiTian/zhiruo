import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { parseChangelog, renderMarkdown } from '@/lib/changelog'
import changelog from '../../CHANGELOG.md?raw'

const CHANGELOG_ENTRIES = parseChangelog(changelog)

interface ChangelogDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

function handleLinkClick(event: React.MouseEvent<HTMLDivElement>) {
  const target = event.target as HTMLElement
  const anchor = target.closest('a')
  if (!anchor) return

  const href = anchor.getAttribute('href')
  if (!href) return

  // 内部锚点保持默认行为，外链交由浏览器 / 系统处理
  if (href.startsWith('#')) return

  // 仅放行 http(s)（renderMarkdown 已过滤，这里做纵深防御）
  if (!/^https?:\/\//i.test(href)) return

  event.preventDefault()

  if (window.electronAPI?.openExternal) {
    window.electronAPI.openExternal(href)
  } else {
    // 降级：无桥方法时在新标签页打开（dev:vite 或未来桥变更场景）
    window.open(href, '_blank', 'noopener,noreferrer')
  }
}

export function ChangelogDialog({ open, onOpenChange }: ChangelogDialogProps) {
  const { t } = useTranslation()

  const renderedEntries = useMemo(
    () =>
      CHANGELOG_ENTRIES.map((entry) => ({
        ...entry,
        html: renderMarkdown(entry.body),
      })),
    [],
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="no-drag max-h-[85vh] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('changelog.title')}</DialogTitle>
          <DialogDescription>{t('changelog.description')}</DialogDescription>
        </DialogHeader>
        <div className="vk-scroll -mr-2 max-h-[60vh] overflow-auto pr-2">
          {renderedEntries.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t('changelog.empty')}</p>
          ) : (
            <div className="flex flex-col gap-4">
              {renderedEntries.map((entry) => (
                <article key={entry.version} className="rounded-xl border bg-card p-4 shadow-sm">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-[15px] font-semibold text-foreground">v{entry.version}</h3>
                    {entry.date ? (
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {entry.date}
                      </span>
                    ) : null}
                  </div>
                  <div
                    className="vk-changelog-md text-[13px] leading-relaxed text-muted-foreground"
                    // 内容来自仓库内 CHANGELOG.md，可信源

                    dangerouslySetInnerHTML={{ __html: entry.html }}
                    onClick={handleLinkClick}
                    role="article"
                  />
                </article>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
