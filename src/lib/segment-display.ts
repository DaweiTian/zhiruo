/** 七段数码管段位：a 上、b 右上、c 右下、d 下、e 左下、f 左上、g 中。 */
export type Segments = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g'

const SEGMENT_MAP: Record<string, string> = {
  '0': 'abcdef',
  '1': 'bc',
  '2': 'abdeg',
  '3': 'abcdg',
  '4': 'bcfg',
  '5': 'acdfg',
  '6': 'acdefg',
  '7': 'abc',
  '8': 'abcdefg',
  '9': 'abcdfg',
  '-': 'g',
  _: 'd',
  '=': 'dg',
}

/** 小数点 / 冒号等以点阵单元渲染，不走段位。 */
export function isDotChar(ch: string): boolean {
  return ch === '.' || ch === ':'
}

/** 取字符对应的点亮段位集合；不支持的字符返回空串。 */
export function getSegments(ch: string): string {
  return SEGMENT_MAP[ch] ?? ''
}
