export interface ChangelogEntry {
  version: string
  date?: string
  body: string
}

const VERSION_HEADING_RE =
  /^#{2,3}\s+\[([^\]]+)\](?:\([^)]*\))?\s*(?:-\s*(\d{4}-\d{2}-\d{2})|\s*\((\d{4}-\d{2}-\d{2})\))?\s*$/

/**
 * 解析语义化版本号为可比较的数字元组。
 * 仅支持 `major.minor.patch` 及可选的 `-prerelease`；prerelease 排在正式版之前。
 */
function parseVersion(version: string): [number, number, number, number] {
  const [core, pre] = version.split('-')
  const parts = core.split('.').map((part) => {
    const num = Number.parseInt(part, 10)
    return Number.isNaN(num) ? 0 : num
  })
  const major = parts[0] ?? 0
  const minor = parts[1] ?? 0
  const patch = parts[2] ?? 0
  // prerelease 用负数占位，保证 0.5.0-beta < 0.5.0
  const preOrder = pre ? -1 : 0
  return [major, minor, patch, preOrder]
}

/**
 * 比较两个语义化版本号。
 * @returns 负数表示 a < b，0 表示相等，正数表示 a > b
 */
export function compareVersion(a: string, b: string): number {
  const av = parseVersion(a)
  const bv = parseVersion(b)
  for (let i = 0; i < av.length; i++) {
    if (av[i] !== bv[i]) return av[i] - bv[i]
  }
  return 0
}

/**
 * 将仓库 CHANGELOG.md 按版本分节。
 *
 * 支持标准 standard-version 格式：
 * - `## [0.5.0] - 2026-10-16`
 * - `## [0.3.0](compare-link) (2026-09-01)`
 * - `### [0.2.1](compare-link) (2026-08-27)`
 *
 * 返回数组按 markdown 中顺序排列（最新版本通常在顶部）。
 *
 * 默认过滤掉早于 0.5.0 的版本；可通过 `minVersion` 指定起始版本。
 */
export function parseChangelog(raw: string, minVersion = '0.5.0'): ChangelogEntry[] {
  const lines = raw.split(/\r?\n/)
  const entries: ChangelogEntry[] = []
  let current: { version: string; date?: string; bodyLines: string[] } | null = null

  const flush = () => {
    if (current) {
      entries.push({
        version: current.version,
        date: current.date,
        body: current.bodyLines.join('\n').trim(),
      })
    }
  }

  for (const line of lines) {
    const match = line.match(VERSION_HEADING_RE)
    if (match) {
      flush()
      current = {
        version: match[1],
        date: match[2] ?? match[3],
        bodyLines: [],
      }
    } else if (current) {
      current.bodyLines.push(line)
    }
  }

  flush()

  return entries.filter((entry) => compareVersion(entry.version, minVersion) >= 0)
}

/**
 * 将 Markdown 子集渲染为 HTML。
 *
 * 覆盖 CHANGELOG.md 正文实际使用的语法：
 * ATX 标题（### / ####）、无序列表、粗体、行内 code、围栏代码块、链接、分隔线。
 *
 * 注入防线：先对**全文**做 HTML 转义（含引号）再解析标记，正文 / 标题 /
 * 列表 / 链接文字都不可能带出原始 HTML；围栏语言串用字符集白名单进 class
 * 属性；链接 href 仅放行 http(s) 协议。
 */
export function renderMarkdown(raw: string): string {
  const escapeHtml = (text: string): string =>
    text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')

  // 全文先转义（占位符 / 标记语法不受影响），后续规则不再二次转义
  let processed = escapeHtml(raw)

  // 1. 提取并替换围栏代码块，避免内部内容被后续规则误处理
  const codeBlocks: { placeholder: string; html: string }[] = []
  processed = processed.replace(
    /^ {0,3}(```|~~~)([^\n]*)\n([\s\S]*?)^ {0,3}\1[\s]*$/gm,
    (_match, _fence, lang: string, code: string) => {
      // 语言串只允许标识符形态进 class 属性，其余整体丢弃
      const trimmed = lang.trim()
      const langClass = /^[a-zA-Z0-9_+#.-]+$/.test(trimmed) ? ` class="language-${trimmed}"` : ''
      const html = `<pre><code${langClass}>${code.replace(/\n$/, '')}</code></pre>`
      const placeholder = `\u0000CODEBLOCK${codeBlocks.length}\u0000`
      codeBlocks.push({ placeholder, html })
      return placeholder
    },
  )

  // 2. 行内格式化（在块级处理前先保护 code 内容）
  const inlineCodes: { placeholder: string; html: string }[] = []
  processed = processed.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const html = `<code>${code}</code>`
    const placeholder = `\u0000INLINECODE${inlineCodes.length}\u0000`
    inlineCodes.push({ placeholder, html })
    return placeholder
  })

  // 粗体（非贪婪，避免跨多个粗体段匹配）
  processed = processed.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')

  // 链接：href 已随全文转义，仍需协议白名单，拒绝 javascript: 等
  processed = processed.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text: string, href: string) =>
    /^https?:\/\//i.test(href)
      ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`
      : `${text} (${href})`,
  )

  // 3. 块级处理
  const lines = processed.split('\n')
  const blocks: string[] = []
  let listItems: string[] = []

  const flushList = () => {
    if (listItems.length > 0) {
      blocks.push(`<ul>\n${listItems.map((item) => `  <li>${item}</li>`).join('\n')}\n</ul>`)
      listItems = []
    }
  }

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed === '') {
      flushList()
      continue
    }

    // 分隔线
    if (/^ {0,3}([-_*])\s*\1\s*\1(?:\1|\s)*$/.test(trimmed)) {
      flushList()
      blocks.push('<hr>')
      continue
    }

    // 标题
    const headingMatch = trimmed.match(/^(#{3,6})\s+(.+)$/)
    if (headingMatch) {
      flushList()
      const depth = Math.min(Math.max(headingMatch[1].length, 3), 6)
      const content = headingMatch[2].trim()
      blocks.push(`<h${depth}>${content}</h${depth}>`)
      continue
    }

    // 列表项
    const listMatch = trimmed.match(/^[\s]*[-*+]\s+(.+)$/)
    if (listMatch) {
      listItems.push(listMatch[1])
      continue
    }

    // 普通段落
    flushList()
    blocks.push(`<p>${line}</p>`)
  }

  flushList()

  let html = blocks.join('\n\n')

  // 4. 恢复占位符
  for (const { placeholder, html: blockHtml } of codeBlocks) {
    html = html.replace(placeholder, blockHtml)
  }
  for (const { placeholder, html: inlineHtml } of inlineCodes) {
    html = html.replace(placeholder, inlineHtml)
  }

  return html.trim()
}
