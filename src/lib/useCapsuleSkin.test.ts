import { describe, expect, it } from 'vitest'
import { resolveCapsuleSkin } from './useCapsuleSkin'

describe('resolveCapsuleSkin (localStorage 归一，非法值回默认经典款)', () => {
  it('accepts pet and falls back to classic for anything else', () => {
    expect(resolveCapsuleSkin('pet')).toBe('pet')
    expect(resolveCapsuleSkin('classic')).toBe('classic')
    expect(resolveCapsuleSkin('dark')).toBe('classic')
    expect(resolveCapsuleSkin('')).toBe('classic')
    expect(resolveCapsuleSkin(null)).toBe('classic')
  })
})
