/**
 * hub 圆环扇形几何（纯函数）：右键胶囊弹出的选区快捷动作面板。
 *
 * 产品定稿（形态规则见项目记忆）：
 * - 自由悬浮：完整圆环，三动作均分扇区，围绕胶囊按钮展开；
 * - 贴靠屏幕边缘：只朝屏幕内侧展开半环（贴右边缘 → 向左展开），屏幕外一侧不画；
 * - 扇区文字沿弧排布（SVG `textPath`），上半环顺时针 / 下半环逆时针翻转，
 *   任何角度都不出现倒字。
 *
 * 角度约定：0° = 正东，顺时针为正（屏幕坐标系，y 轴向下）。
 * 布局与 2026-06 定稿示意图逐值一致，改数值前先改图。
 */

export type HubDockEdge = 'left' | 'right' | 'top' | 'bottom'
export type HubAction = 'translate' | 'polish' | 'explain'
/** 文字沿弧走向：`cw` 顺时针（上半环）、`ccw` 逆时针（下半环翻转）。 */
export type HubLabelFlow = 'cw' | 'ccw'

/** hub 窗口 viewBox 边长（逻辑 px，与 Rust `hub::HUB_WINDOW_SIZE` 同值）。 */
export const HUB_VIEW_SIZE = 260
export const HUB_RING_CENTER = HUB_VIEW_SIZE / 2
export const RING_INNER_R = 40
export const RING_OUTER_R = 88

/** 动作固定顺序（展示序，不是角度序）。 */
export const HUB_ACTIONS: readonly HubAction[] = ['translate', 'polish', 'explain']

/** 全环：每扇区 112°，扇区间隙 8°（3×112 + 3×8 = 360）。 */
const FULL_SPAN_DEG = 112
/** 半环：每扇区 52°，扇区间隙 8°、两端留 4°（3×52 + 2×8 + 2×4 = 180）。 */
const HALF_SPAN_DEG = 52

/**
 * 全环扇形中心角：翻译正上、润色右下、解释左下（定稿图位置）。
 */
const FULL_RING_CENTERS: Record<HubAction, number> = {
  translate: -90,
  polish: 30,
  explain: 150,
}

/**
 * 半环扇形中心角（贴边）：开口 = 屏幕内侧方向；动作按视觉阅读序排列
 * （竖边自上而下、横边自左而右）。右边缘一组与定稿图逐值一致。
 */
const HALF_RING_CENTERS: Record<HubDockEdge, Record<HubAction, number>> = {
  // 开口向西（180°）：翻译左上、润色正左、解释左下
  right: { translate: 240, polish: 180, explain: 120 },
  // 开口向东（0°）：翻译右上、润色正右、解释右下
  left: { translate: -60, polish: 0, explain: 60 },
  // 开口向南（90°）：翻译左下、润色正下、解释右下
  top: { translate: 150, polish: 90, explain: 30 },
  // 开口向北（270°）：翻译左上、润色正上、解释右上
  bottom: { translate: 210, polish: 270, explain: 330 },
}

export interface HubSector {
  action: HubAction
  /** 扇形填充路径（外弧 + 内弧闭合）。 */
  fillPath: string
  /** 文字沿弧路径（基线中弧），配 SVG `textPath` 使用。 */
  labelPath: string
  midAngle: number
  flow: HubLabelFlow
  /** 文字基线半径（顺弧方向按字高中线对齐扇形带）。 */
  labelRadius: number
}

/** 12px 字号的字身半高 ≈ 5px：基线相对扇形中径的偏移，让字身沿带中线。 */
const GLYPH_HALF_HEIGHT = 5
const RING_MID_R = (RING_INNER_R + RING_OUTER_R) / 2

const fmt = (n: number): string => (Math.round(n * 100) / 100).toString()

export function polar(angleDeg: number, radius: number): [number, number] {
  const rad = (angleDeg * Math.PI) / 180
  return [HUB_RING_CENTER + radius * Math.cos(rad), HUB_RING_CENTER + radius * Math.sin(rad)]
}

/**
 * 文字沿弧走向（「不倒字」规则）：上半环顺时针、下半环逆时针；
 * 正东 / 正西这类水平位置取「自上而下」可读方向。
 */
export function labelFlowFor(midAngleDeg: number): HubLabelFlow {
  const rad = (midAngleDeg * Math.PI) / 180
  const sin = Math.sin(rad)
  if (sin < -1e-9) return 'cw'
  if (sin > 1e-9) return 'ccw'
  // 水平位置：东侧顺时针（自上而下）、西侧逆时针（自上而下）。
  return Math.cos(rad) > 0 ? 'cw' : 'ccw'
}

function sectorFillPath(centerDeg: number, spanDeg: number): string {
  const a0 = centerDeg - spanDeg / 2
  const a1 = centerDeg + spanDeg / 2
  const [x0, y0] = polar(a0, RING_OUTER_R)
  const [x1, y1] = polar(a1, RING_OUTER_R)
  const [x2, y2] = polar(a1, RING_INNER_R)
  const [x3, y3] = polar(a0, RING_INNER_R)
  // 外弧角度递增 = 顺时针（sweep 1）；内弧回程 = 逆时针（sweep 0）。
  return [
    `M ${fmt(x0)} ${fmt(y0)}`,
    `A ${RING_OUTER_R} ${RING_OUTER_R} 0 0 1 ${fmt(x1)} ${fmt(y1)}`,
    `L ${fmt(x2)} ${fmt(y2)}`,
    `A ${RING_INNER_R} ${RING_INNER_R} 0 0 0 ${fmt(x3)} ${fmt(y3)}`,
    'Z',
  ].join(' ')
}

function labelArcPath(
  centerDeg: number,
  spanDeg: number,
  flow: HubLabelFlow,
  radius: number,
): string {
  const a0 = centerDeg - spanDeg / 2
  const a1 = centerDeg + spanDeg / 2
  // `cw` 路径角度递增；`ccw` 起终点互换，textPath 文字随弧反向排布。
  const [from, to, sweep] = flow === 'cw' ? [a0, a1, 1] : [a1, a0, 0]
  const [x0, y0] = polar(from, radius)
  const [x1, y1] = polar(to, radius)
  return `M ${fmt(x0)} ${fmt(y0)} A ${radius} ${radius} 0 0 ${sweep} ${fmt(x1)} ${fmt(y1)}`
}

/**
 * 构造 hub 扇形布局：`dockEdge = null` 完整圆环；否则半环朝屏幕内展开。
 * 返回顺序 = `HUB_ACTIONS` 展示顺序。
 */
export function buildHubSectors(dockEdge: HubDockEdge | null): HubSector[] {
  const span = dockEdge === null ? FULL_SPAN_DEG : HALF_SPAN_DEG
  const centers = dockEdge === null ? FULL_RING_CENTERS : HALF_RING_CENTERS[dockEdge]
  return HUB_ACTIONS.map((action) => {
    const midAngle = centers[action]
    const flow = labelFlowFor(midAngle)
    // 顺时针文字字身朝外（基线内收），逆时针字身朝内（基线外推）。
    const labelRadius =
      flow === 'cw' ? RING_MID_R - GLYPH_HALF_HEIGHT : RING_MID_R + GLYPH_HALF_HEIGHT
    return {
      action,
      fillPath: sectorFillPath(midAngle, span),
      labelPath: labelArcPath(midAngle, span, flow, labelRadius),
      midAngle,
      flow,
      labelRadius,
    }
  })
}

/**
 * 按环心落位推导贴边方向：完整圆环在窗口内放不下（环心距某条窗口边不足
 * [`RING_OUTER_R`]）时返回该边的半环朝向，放得下返回 `null`（完整圆环）。
 *
 * hub 窗口整只钳在屏幕工作区内、圆环按 `ringCenter` 钉在胶囊上，所以
 * 「环心贴窗口边」== 「胶囊贴屏幕边」——不仅吸附态（config `overlayDocked`）
 * 要半环，**接近**屏幕边缘而未吸附时同样要（全环会被窗口裁缺一角）。
 * 多边同时放不下（角落）取最近的边；并列时按右 / 左 / 下 / 上取先者。
 */
export function edgeFromRingCenter(ringCenter: { x: number; y: number }): HubDockEdge | null {
  const overflows: Array<[HubDockEdge, number]> = [
    ['right', ringCenter.x + RING_OUTER_R - HUB_VIEW_SIZE],
    ['left', RING_OUTER_R - ringCenter.x],
    ['bottom', ringCenter.y + RING_OUTER_R - HUB_VIEW_SIZE],
    ['top', RING_OUTER_R - ringCenter.y],
  ]
  let best: [HubDockEdge, number] | null = null
  for (const candidate of overflows) {
    if (candidate[1] > 0 && (best === null || candidate[1] > best[1])) {
      best = candidate
    }
  }
  return best === null ? null : best[0]
}
