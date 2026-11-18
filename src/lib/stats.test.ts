import { describe, expect, it } from 'vitest'
import {
  computeBadges,
  computeStats,
  countCharacters,
  type HistoryItem,
  type StoredDictationStats,
} from './stats'

/**
 * 本套用例是 Rust 单测 `count_characters_matches_frontend_whitespace_rule`
 * （`src-tauri/src/stats.rs`）的 JS 镜像：两侧必须逐字使用同一计数口径——
 * **Unicode 码点**（Rust `chars()` / JS `Array.from`）剔除全部空白字符后计数。
 * 改任一侧的口径都要同步另一侧与本测试。
 */
describe('countCharacters (mirrors Rust count_characters_matches_frontend_whitespace_rule)', () => {
  it('drops every whitespace character and counts the rest (same asserts as Rust)', () => {
    // 前三个断言与 Rust 单测逐字相同，其后为 JS 侧补充边界
    expect(countCharacters('hello world')).toBe(10)
    expect(countCharacters(' 你 好\n\t世界 ')).toBe(4)
    expect(countCharacters('   \n\t')).toBe(0)
    expect(countCharacters('')).toBe(0)
    expect(countCharacters('你好 world')).toBe(7)
  })

  it('counts each emoji as one Unicode code point, not two UTF-16 units', () => {
    // "👋🏽a b" = 👋 + 🏽 + a + b = 4 个码点（Rust chars() 计 4）
    expect(countCharacters('👋🏽a b')).toBe(4)
    // 单个 emoji：码点口径 1；旧 UTF-16 口径（'👍'.length）会记 2
    expect(countCharacters('👍')).toBe(1)
    expect('👍'.length).toBe(2)
    // emoji 序列中间的空白同样剔除
    expect(countCharacters('👍 👍')).toBe(2)
  })

  it('treats Unicode space separators as whitespace like Rust is_whitespace', () => {
    // NBSP / EN QUAD / LINE SEPARATOR / 全角空格均按空白剔除
    expect(countCharacters('\u00a0a\u2000b\u2028c\u3000d')).toBe(4)
    // U+200B 零宽空格不是空白字符，两侧都计数
    expect(countCharacters('\u200b')).toBe(1)
    // 混合：CJK + emoji + 制表符 + 换行 = 你 好 👋 🏽 世 界 = 6 个码点
    expect(countCharacters('你好\t👋🏽\n世界')).toBe(6)
  })
})

/**
 * 问题④回归锁定：删除/清空历史后，Home 页所有统计**不得减少**。
 * 修复前「今日次数/今日时长/今日字数/近 7 日」由 historyItems 实时聚合，
 * 删历史即缩水；修复后 stored 存在时全部取自持久化统计（`daily`）。
 */
describe('computeStats (persisted window fields survive history deletion)', () => {
  const now = new Date()
  const buildKey = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(
      2,
      '0',
    )}`
  const todayKey = buildKey(now)
  const yesterdayKey = buildKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))

  const stored: StoredDictationStats = {
    version: 3,
    backfilled: true,
    totals: { sessions: 10, characters: 1000, audioMs: 60000 },
    daily: {
      [todayKey]: { sessions: 4, characters: 200, audioMs: 12000 },
      [yesterdayKey]: { sessions: 3, characters: 150, audioMs: 9000 },
    },
    hourly: { '9': 300, '21': 50 },
  }

  const historyItem = (
    id: string,
    text: string,
    duration: number,
    timestamp: number,
  ): HistoryItem => ({
    id,
    text,
    timestamp,
    duration,
  })

  const todaysHistory = [historyItem('1', 'hello', 3000, now.getTime())]

  it('reads today / recent window from stored, unaffected by emptying history', () => {
    const withHistory = computeStats(todaysHistory, stored)
    const withoutHistory = computeStats([], stored)
    // 唯一权威来源是 stored：删掉全部历史后每个字段都必须逐字相等。
    expect(withoutHistory).toEqual(withHistory)
    expect(withoutHistory.todaySessions).toBe(4)
    expect(withoutHistory.todayDuration).toBe(12000)
    expect(withoutHistory.todayCharacters).toBe(200)
    // 近 7 日 = 今天 + 昨天（日历日窗）
    expect(withoutHistory.recentCharacters).toBe(350)
    expect(withoutHistory.recentAudioMs).toBe(21000)
    expect(withoutHistory.totalCharacters).toBe(1000)
    expect(withoutHistory.activeDays).toBe(2)
    expect(withoutHistory.peakDayCharacters).toBe(200)
    expect(withoutHistory.peakDayKey).toBe(todayKey)
    // 今天 + 昨天连续，stored 存在时不受历史有无影响
    expect(withoutHistory.streakDays).toBe(2)
    expect(withoutHistory.longestStreak).toBe(2)
    expect(withoutHistory.totalSessions).toBe(10)
    // 小时桶来自 stored.hourly（24 桶，仅 9 / 21 点非零）
    expect(withoutHistory.hourly).toHaveLength(24)
    expect(withoutHistory.hourly[9]).toBe(300)
    expect(withoutHistory.hourly[21]).toBe(50)
    expect(withoutHistory.hourly[0]).toBe(0)
    expect(withoutHistory.hourly.reduce((a, b) => a + b, 0)).toBe(350)
  })

  it('degrades to pure history aggregation when stored is missing', () => {
    const stats = computeStats(todaysHistory)
    expect(stats.totalCharacters).toBe(5)
    expect(stats.totalSessions).toBe(1)
    expect(stats.todaySessions).toBe(1)
    expect(stats.todayCharacters).toBe(5)
    expect(stats.todayDuration).toBe(3000)
    expect(stats.recentCharacters).toBe(5)
    expect(stats.activeDays).toBe(1)
    expect(stats.streakDays).toBe(1)
    expect(stats.longestStreak).toBe(1)
  })
})

/** 4.1 听写战绩：连续天数口径（含断签与「今天还没开始」的锚点回退）。 */
describe('computeStats streaks (consecutive calendar days, break resets)', () => {
  const now = new Date()
  const buildKey = (offsetDays: number) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offsetDays)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`
  }
  const dayAt = (characters = 10) => ({
    sessions: 1,
    characters,
    audioMs: 100,
  })

  const storedWith = (
    offsets: number[],
    totals = { sessions: offsets.length, characters: offsets.length * 10, audioMs: 0 },
  ): StoredDictationStats => ({
    version: 3,
    backfilled: true,
    totals,
    daily: Object.fromEntries(offsets.map((o) => [buildKey(o), dayAt()])),
    hourly: {},
  })

  it('counts today plus consecutive past days (break in the middle resets the run)', () => {
    // 今天 0、昨天 1、前天 2 连续；5 天前断签后 6、7 又连续
    const stats = computeStats([], storedWith([0, 1, 2, 5, 6, 7]))
    expect(stats.streakDays).toBe(3)
    expect(stats.longestStreak).toBe(3)
  })

  it('keeps a longer past run as longestStreak even when the current one is shorter', () => {
    // 8..4 连续 5 天是历史最长；今天 0 是新的 1 天连续（昨天断了）
    const stats = computeStats([], storedWith([0, 4, 5, 6, 7, 8]))
    expect(stats.streakDays).toBe(1)
    expect(stats.longestStreak).toBe(5)
  })

  it('anchors on yesterday when today has no dictation yet (GitHub-style)', () => {
    const stats = computeStats([], storedWith([1, 2, 3]))
    expect(stats.streakDays).toBe(3)
    expect(stats.longestStreak).toBe(3)
  })

  it('reports zero streaks when even yesterday has no dictation', () => {
    const stats = computeStats([], storedWith([2, 3]))
    expect(stats.streakDays).toBe(0)
    expect(stats.longestStreak).toBe(2)
  })

  it('falls back to history-derived day keys when stored is missing', () => {
    const ts = now.getTime()
    // 日历日昨天（正午取点，避开夏令时切换对 24h 平移的干扰）
    const yesterdayTs = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12).getTime()
    const items: HistoryItem[] = [
      { id: '1', text: 'x'.repeat(10), timestamp: ts, duration: 1 },
      { id: '2', text: 'x'.repeat(10), timestamp: yesterdayTs, duration: 1 },
    ]
    const stats = computeStats(items)
    expect(stats.streakDays).toBe(2)
    expect(stats.longestStreak).toBe(2)
  })

  it('drops malformed day keys instead of counting them as an active run', () => {
    const stats = computeStats([], {
      version: 3,
      backfilled: true,
      totals: { sessions: 0, characters: 0, audioMs: 0 },
      daily: { garbage: { sessions: 1, characters: 5, audioMs: 0 } },
      hourly: {},
    })
    expect(stats.streakDays).toBe(0)
    expect(stats.longestStreak).toBe(0)
  })
})

/** 4.1 听写战绩：小时桶（stored 权威；缺失时按历史本地小时聚合）。 */
describe('computeStats hourly buckets (heatmap input, 24 local hours)', () => {
  it('ignores out-of-range or non-finite stored hour keys', () => {
    const now = new Date()
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate(),
    ).padStart(2, '0')}`
    const stats = computeStats([], {
      version: 3,
      backfilled: true,
      totals: { sessions: 1, characters: 7, audioMs: 0 },
      daily: { [todayKey]: { sessions: 1, characters: 7, audioMs: 0 } },
      hourly: {
        '8': 7,
        // Number() 可解析的旁路键与负值都必须丢弃，不能污染桶
        '24': 100,
        '-1': 100,
        x: 100,
        '': 100,
        '1e1': 100,
        '0x2': 100,
        '9': Number.NaN,
        '10': -5,
      },
    })
    expect(stats.hourly[8]).toBe(7)
    expect(stats.hourly.reduce((a, b) => a + b, 0)).toBe(7)
  })

  it('aggregates history items into local hour buckets when stored is missing', () => {
    const base = new Date(2026, 0, 15, 10, 30).getTime()
    const items: HistoryItem[] = [
      { id: '1', text: 'abcde', timestamp: base, duration: 1 },
      { id: '2', text: 'fgh', timestamp: base, duration: 1 },
      { id: '3', text: 'ijk', timestamp: new Date(2026, 0, 15, 23, 0).getTime(), duration: 1 },
    ]
    const stats = computeStats(items)
    expect(stats.hourly[10]).toBe(8)
    expect(stats.hourly[23]).toBe(3)
    expect(stats.hourly.reduce((a, b) => a + b, 0)).toBe(11)
  })

  it('ignores selection originals in history fallback (dictation-only stats)', () => {
    // 选区原文（source: "selection"）只入史供回溯、从不走 record_add，
    // 回退聚合（含小时桶）必须同步排除，与 Rust 回填过滤一致。
    const ts = Date.now()
    const items: HistoryItem[] = [
      { id: '1', text: 'x'.repeat(10), timestamp: ts, duration: 1 },
      {
        id: '2',
        text: 'y'.repeat(50),
        timestamp: ts,
        duration: 9999,
        source: 'selection',
      },
    ]
    const stats = computeStats(items)
    expect(stats.totalCharacters).toBe(10)
    expect(stats.totalSessions).toBe(1)
    expect(stats.totalAudioMs).toBe(1)
    expect(stats.activeDays).toBe(1)
    expect(stats.hourly.reduce((a, b) => a + b, 0)).toBe(10)
    expect(stats.streakDays).toBe(1)
    expect(stats.longestStreak).toBe(1)
  })
})

/** 4.1 听写战绩：徽章由 totals / 峰值日 / 最长连续纯推导，两态全集。 */
describe('computeBadges (derived achievements, full two-state set)', () => {
  const base = {
    totalSessions: 0,
    totalCharacters: 0,
    totalAudioMs: 0,
    recentCharacters: 0,
    recentAudioMs: 0,
    todaySessions: 0,
    todayDuration: 0,
    todayCharacters: 0,
    activeDays: 0,
    peakDayCharacters: 0,
    peakDayKey: null,
    streakDays: 0,
    longestStreak: 0,
    hourly: new Array<number>(24).fill(0),
  }

  it('lights nothing before the first dictation', () => {
    const badges = computeBadges(base)
    expect(Object.values(badges).every((v) => !v)).toBe(true)
  })

  it('lights each badge exactly at its threshold', () => {
    expect(computeBadges({ ...base, totalSessions: 1 })['first-dictation']).toBe(true)
    expect(computeBadges({ ...base, totalCharacters: 999 })['chars-1k']).toBe(false)
    expect(computeBadges({ ...base, totalCharacters: 1_000 })['chars-1k']).toBe(true)
    expect(computeBadges({ ...base, totalCharacters: 10_000 })['chars-10k']).toBe(true)
    expect(computeBadges({ ...base, totalCharacters: 100_000 })['chars-100k']).toBe(true)
    expect(computeBadges({ ...base, longestStreak: 7 })['streak-7']).toBe(true)
    expect(computeBadges({ ...base, longestStreak: 30 })['streak-30']).toBe(true)
    expect(computeBadges({ ...base, peakDayCharacters: 1_000 })['day-1k']).toBe(true)
    expect(computeBadges({ ...base, totalAudioMs: 3_600_000 })['audio-1h']).toBe(true)
  })
})
