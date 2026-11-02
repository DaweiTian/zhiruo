import { describe, expect, it } from 'vitest'
import { compareVersion, parseChangelog, renderMarkdown } from './changelog'

const FIXTURE = `
# Changelog

## [0.10.0] - 2026-10-25

### Features

- future double-digit version

## [0.5.0] - 2026-10-15

### Features

- milestone release

## [0.4.12] - 2026-10-10

### Bug Fixes

- old patch

## [0.3.0](https://example.com/v0.3.0) (2026-09-01)

### Features

- ancient release
`

describe('compareVersion', () => {
  it('treats 0.10.0 as newer than 0.5.0', () => {
    expect(compareVersion('0.10.0', '0.5.0')).toBeGreaterThan(0)
  })

  it('treats 0.5.0 as newer than 0.4.12', () => {
    expect(compareVersion('0.5.0', '0.4.12')).toBeGreaterThan(0)
  })

  it('treats 0.4.12 as newer than 0.3.0', () => {
    expect(compareVersion('0.4.12', '0.3.0')).toBeGreaterThan(0)
  })

  it('considers equal versions equal', () => {
    expect(compareVersion('0.5.0', '0.5.0')).toBe(0)
  })

  it('sorts prereleases before the release', () => {
    expect(compareVersion('0.5.0-beta', '0.5.0')).toBeLessThan(0)
  })
})

describe('parseChangelog', () => {
  it('filters out versions older than 0.5.0 by default', () => {
    const entries = parseChangelog(FIXTURE)
    const versions = entries.map((entry) => entry.version)

    expect(versions).toContain('0.10.0')
    expect(versions).toContain('0.5.0')
    expect(versions).not.toContain('0.4.12')
    expect(versions).not.toContain('0.3.0')
  })

  it('keeps 0.5.0 exactly', () => {
    const entries = parseChangelog(FIXTURE)
    expect(entries.some((entry) => entry.version === '0.5.0')).toBe(true)
  })

  it('does not filter double-digit minor versions as strings', () => {
    const entries = parseChangelog(FIXTURE)
    expect(entries.some((entry) => entry.version === '0.10.0')).toBe(true)
  })

  it('respects a custom minVersion', () => {
    const entries = parseChangelog(FIXTURE, '0.4.0')
    const versions = entries.map((entry) => entry.version)

    expect(versions).toContain('0.10.0')
    expect(versions).toContain('0.5.0')
    expect(versions).toContain('0.4.12')
    expect(versions).not.toContain('0.3.0')
  })
})

describe('renderMarkdown', () => {
  it('renders headings, lists, bold, code and links', () => {
    const md = `### Features

- **config:** 存储位置可切换 \`<exe_dir>\\data\\\`
- 云端 [MiMo](https://mimo.example.com) 识别

---

#### Notes

some note`
    const html = renderMarkdown(md)

    expect(html).toContain('<h3>Features</h3>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<li><strong>config:</strong>')
    expect(html).toContain('<code>&lt;exe_dir&gt;\\data\\</code>')
    expect(html).toContain('<a href="https://mimo.example.com"')
    expect(html).toContain('<hr>')
    expect(html).toContain('<h4>Notes</h4>')
  })

  it('escapes HTML in plain text and code blocks', () => {
    const md = '```\n<script>alert(1)</script>\n```'
    const html = renderMarkdown(md)

    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
  })
})
