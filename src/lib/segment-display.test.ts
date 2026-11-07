import { describe, expect, it } from 'vitest'
import { getSegments, isDotChar } from './segment-display'

describe('getSegments', () => {
  it('maps every digit to its lit segments', () => {
    expect(getSegments('0')).toBe('abcdef')
    expect(getSegments('1')).toBe('bc')
    expect(getSegments('5')).toBe('acdfg')
    expect(getSegments('8')).toBe('abcdefg')
    expect(getSegments('9')).toBe('abcdfg')
  })

  it('supports dash-like glyphs and blanks unknown chars', () => {
    expect(getSegments('-')).toBe('g')
    expect(getSegments('_')).toBe('d')
    expect(getSegments('=')).toBe('dg')
    expect(getSegments('a')).toBe('')
    expect(getSegments('')).toBe('')
  })
})

describe('isDotChar', () => {
  it('treats period and colon as dot cells', () => {
    expect(isDotChar('.')).toBe(true)
    expect(isDotChar(':')).toBe(true)
    expect(isDotChar('0')).toBe(false)
    expect(isDotChar('')).toBe(false)
  })
})
