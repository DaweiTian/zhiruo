export interface HistoryItem {
  id: string
  text: string
  timestamp: number
  duration?: number
  /** `selection` = 选区动作替换前的原文快照（可回溯）；缺省 = 语音听写。 */
  source?: string
}

export interface DictationStats {
  totalSessions: number
  totalCharacters: number
  totalAudioMs: number
  recentCharacters: number
  recentAudioMs: number
  todaySessions: number
  todayDuration: number
  todayCharacters: number
  activeDays: number
  peakDayCharacters: number
  peakDayKey: string | null
  /** 当前连续天数（今天有听写则含今天；今天还没有则从昨天起算；都没有 = 0） */
  streakDays: number
  /** 历史最长连续天数（断签重起） */
  longestStreak: number
  /** 本地小时 0..23 -> 累计识别字符数（长度恒为 24，热力图输入） */
  hourly: number[]
}

/**
 * Rust `src-tauri/src/stats.rs` 独立持久化的累计统计（`voice-key-stats.json`，
 * serde camelCase）。只增不减：不受历史删除与 90 天保留裁剪影响。
 */
export interface StoredDayStats {
  /** 当日成功识别会话数 */
  sessions: number
  /** 当日识别字符数（非空白，见 `countCharacters`） */
  characters: number
  /** 当日录音音频毫秒数（未知时长计 0） */
  audioMs: number
}

export interface StoredDictationStats {
  version: number
  backfilled: boolean
  totals: {
    sessions: number
    characters: number
    audioMs: number
  }
  /** 本地日键 `YYYY-MM-DD` -> 当日统计（次数 / 字符数 / 音频毫秒） */
  daily: Record<string, StoredDayStats>
  /** 本地小时键 `"0".."23"` -> 累计字符数（v3 迁移后恒有；serde BTreeMap<u8,_> 的键是字符串） */
  hourly: Record<string, number>
}

/**
 * 非空白字符数，按 **Unicode 码点** 计数，与 Rust `src-tauri/src/stats.rs`
 * `count_characters`（`text.chars().filter(|c| !c.is_whitespace()).count()`）逐字对齐：
 * `Array.from` 把字符串拆成码点（emoji 等代理对计 1，而非 UTF-16 码元的 2），
 * 再剔除空白字符。历史字数、图表趋势与 Rust 累计统计共用这一口径，
 * 任何改动必须同步两侧。回归锁定见 `stats.test.ts`（镜像 Rust 单测
 * `count_characters_matches_frontend_whitespace_rule`）。
 */
export const countCharacters = (text: string): number =>
  Array.from(text).filter((c) => !/\s/u.test(c)).length

const sumValues = (values: number[]): number => values.reduce((total, value) => total + value, 0)

const buildDateKey = (date: Date): string => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 峰值日：按 dayKey 升序遍历、严格大于 → 平局取最早的一天（与 Rust `BTreeMap` 序一致）。 */
function derivePeak(daily: Map<string, number> | Record<string, number>): {
  peakDayCharacters: number
  peakDayKey: string | null
} {
  const entries = daily instanceof Map ? [...daily.entries()] : Object.entries(daily)
  let peakDayCharacters = 0
  let peakDayKey: string | null = null
  entries
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .forEach(([key, chars]) => {
      if (chars > peakDayCharacters) {
        peakDayCharacters = chars
        peakDayKey = key
      }
    })
  return { peakDayCharacters, peakDayKey }
}

/** `YYYY-MM-DD` -> 自 Unix 纪元起的「日序号」（UTC 零点整除，不受夏令时影响）。 */
function dayKeyToIndex(key: string): number {
  const [y, m, d] = key.split('-').map(Number)
  return Date.UTC(y, m - 1, d) / 86_400_000
}

/**
 * 连续天数（current / longest）。活跃日集合取 `daily` 日期键（缺失时由历史聚合），
 * 相邻日序号差 1 即连续。当前连续：今天有活动从今天往回数；今天还没有、昨天有
 * （GitHub 贡献条口径）从昨天往回数；都没有 = 0。非法日键（解析不出整数日序号）
 * 直接丢弃，不参与任何 run。
 */
function deriveStreaks(
  dailyKeys: Iterable<string>,
  now: Date,
): {
  streakDays: number
  longestStreak: number
} {
  const indices = [...new Set([...dailyKeys].map(dayKeyToIndex))]
    .filter(Number.isInteger)
    .sort((a, b) => a - b)
  if (indices.length === 0) return { streakDays: 0, longestStreak: 0 }
  let longestStreak = 1
  let run = 1
  for (let i = 1; i < indices.length; i += 1) {
    run = indices[i] - indices[i - 1] === 1 ? run + 1 : 1
    if (run > longestStreak) longestStreak = run
  }
  const active = new Set(indices)
  const todayIndex = dayKeyToIndex(buildDateKey(now))
  let anchor = active.has(todayIndex)
    ? todayIndex
    : active.has(todayIndex - 1)
      ? todayIndex - 1
      : -1
  let streakDays = 0
  while (anchor >= 0 && active.has(anchor)) {
    streakDays += 1
    anchor -= 1
  }
  return { streakDays, longestStreak }
}

/**
 * 本地小时 0..23 的 24 桶字符数。`stored` 存在时**权威**（空桶就是 0，不回退
 * 历史——否则删除历史会缩水热力图）；仅 `stored` 整体缺失时由历史实时聚合
 * （入参须已是听写项）。键严格 `0`.."23"` 十进制（拒绝 `1e1`/`0x2` 等 Number
 * 可解析的旁路），值要求有限非负。
 */
function deriveHourly(historyItems: HistoryItem[], stored?: StoredDictationStats | null): number[] {
  const hourly = new Array<number>(24).fill(0)
  if (stored) {
    for (const [key, value] of Object.entries(stored.hourly ?? {})) {
      if (!/^\d{1,2}$/.test(key)) continue
      const hour = Number(key)
      if (hour <= 23 && Number.isFinite(value) && value >= 0) {
        hourly[hour] += value
      }
    }
    return hourly
  }
  historyItems.forEach((item) => {
    const hour = new Date(item.timestamp).getHours()
    hourly[hour] += countCharacters(item.text)
  })
  return hourly
}

/**
 * 近 `rangeDays` 个**日历日**（含今天）的窗口求和，按本地 dayKey 逐日取
 * `stored.daily`。持久化日粒度只到「天」，无法还原历史聚合原来的滑动毫秒窗，
 * 但日历日窗更直观，且与 dayKey 口径一致。
 */
function sumRecentCalendarDays(
  daily: Record<string, StoredDayStats>,
  rangeDays: number,
  now: Date,
): { sessions: number; characters: number; audioMs: number } {
  let sessions = 0
  let characters = 0
  let audioMs = 0
  for (let i = 0; i < rangeDays; i += 1) {
    const entry =
      daily[buildDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i))]
    if (!entry) continue
    sessions += entry.sessions
    characters += entry.characters
    audioMs += entry.audioMs
  }
  return { sessions, characters, audioMs }
}

/**
 * 从听写历史与 Rust 持久化统计计算概览（今日 / 近 N 天 / 累计 / 活跃天数 / 峰值日）。
 *
 * 合并语义：`stored` 存在时**所有字段**均取 `stored`（Rust 侧独立持久化、只增不减，
 * 历史删除 / 90 天裁剪不影响）——累计类直接读 `totals`；今日读 `daily[todayKey]`；
 * 近 N 天按日历日求和 `daily`。`stored` 缺失（老版本回退 / `get_stats` 失败）时
 * 整体降级为纯历史实时聚合，不抛错（此时窗口字段才会随历史删除而缩水）。
 */
export function computeStats(
  historyItems: HistoryItem[],
  stored?: StoredDictationStats | null,
  rangeDays = 7,
): DictationStats {
  // 统计口径 = 语音听写：选区动作原文（source: "selection"）只入史供回溯，
  // 从不走 Rust `record_add`，回退聚合必须同步排除（与 Rust 回填过滤一致）。
  const dictationItems = historyItems.filter(
    (item) => item.source === undefined || item.source === null,
  )
  const historyTotalCharacters = sumValues(dictationItems.map((item) => countCharacters(item.text)))
  const historyTotalAudioMs = sumValues(dictationItems.map((item) => item.duration ?? 0))

  const now = new Date()
  // 回退口径（仅 stored 缺失时使用）：滑动毫秒窗 + 当日时间戳过滤。
  const cutoff = new Date(now.getTime() - rangeDays * 24 * 60 * 60 * 1000)
  const recentItems = dictationItems.filter((item) => item.timestamp >= cutoff.getTime())
  const todayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    0,
    0,
    0,
    0,
  ).getTime()
  const todayEnd = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    23,
    59,
    59,
    999,
  ).getTime()
  const todayItems = dictationItems.filter(
    (item) => item.timestamp >= todayStart && item.timestamp <= todayEnd,
  )

  const historyDailyMap = new Map<string, number>()
  dictationItems.forEach((item) => {
    const key = buildDateKey(new Date(item.timestamp))
    historyDailyMap.set(key, (historyDailyMap.get(key) ?? 0) + countCharacters(item.text))
  })

  const storedToday = stored?.daily[buildDateKey(now)]
  const storedRecent = stored ? sumRecentCalendarDays(stored.daily, rangeDays, now) : null
  const dailyCharsForPeak: Map<string, number> | Record<string, number> = stored
    ? Object.fromEntries(
        Object.entries(stored.daily).map(([key, day]) => [key, day.characters] as const),
      )
    : historyDailyMap
  const { peakDayCharacters, peakDayKey } = derivePeak(dailyCharsForPeak)
  const { streakDays, longestStreak } = deriveStreaks(
    stored ? Object.keys(stored.daily) : historyDailyMap.keys(),
    now,
  )

  return {
    totalSessions: stored ? stored.totals.sessions : dictationItems.length,
    totalCharacters: stored ? stored.totals.characters : historyTotalCharacters,
    totalAudioMs: stored ? stored.totals.audioMs : historyTotalAudioMs,
    recentCharacters: storedRecent
      ? storedRecent.characters
      : sumValues(recentItems.map((item) => countCharacters(item.text))),
    recentAudioMs: storedRecent
      ? storedRecent.audioMs
      : sumValues(recentItems.map((item) => item.duration ?? 0)),
    todaySessions: stored ? (storedToday?.sessions ?? 0) : todayItems.length,
    todayDuration: stored
      ? (storedToday?.audioMs ?? 0)
      : sumValues(todayItems.map((item) => item.duration ?? 0)),
    todayCharacters: stored
      ? (storedToday?.characters ?? 0)
      : sumValues(todayItems.map((item) => countCharacters(item.text))),
    activeDays: stored ? Object.keys(stored.daily).length : historyDailyMap.size,
    peakDayCharacters,
    peakDayKey,
    streakDays,
    longestStreak,
    hourly: deriveHourly(dictationItems, stored),
  }
}

/** 成就徽章清单（id 稳定，文案在 i18n `home.badge*`；可逐步扩，勿改已有 id）。 */
export const DICTATION_BADGE_IDS = [
  'first-dictation',
  'chars-1k',
  'chars-10k',
  'chars-100k',
  'streak-7',
  'streak-30',
  'day-1k',
  'audio-1h',
] as const
export type DictationBadgeId = (typeof DICTATION_BADGE_IDS)[number]

/**
 * 纯前端推导徽章点亮态（[`DICTATION_BADGE_IDS`] 全集两态）。
 * 由累计 / 峰值日 / 最长连续推导，无独立存储。
 */
export function computeBadges(stats: DictationStats): Record<DictationBadgeId, boolean> {
  return {
    'first-dictation': stats.totalSessions > 0,
    'chars-1k': stats.totalCharacters >= 1_000,
    'chars-10k': stats.totalCharacters >= 10_000,
    'chars-100k': stats.totalCharacters >= 100_000,
    'streak-7': stats.longestStreak >= 7,
    'streak-30': stats.longestStreak >= 30,
    'day-1k': stats.peakDayCharacters >= 1_000,
    'audio-1h': stats.totalAudioMs >= 3_600_000,
  }
}
