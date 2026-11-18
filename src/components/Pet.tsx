import { CSSProperties, useEffect, useRef } from 'react'
import { cn } from '../lib/utils'

/** 叶精灵五态（映射 `OverlayStatus`；processing 三档只由胶囊文案区分，形态同一）。 */
export type PetState = 'idle' | 'recording' | 'processing' | 'success' | 'error'

interface PetProps {
  state: PetState
  /** 0..1 录音电平：写入 `--pet-level`，驱动张嘴幅度与轻微弹跳（recording 态） */
  audioLevel?: number
  /** 渲染边长 px（会话胶囊内上限 40，防挤压文字） */
  size?: number
  className?: string
}

/**
 * 胶囊宠物「叶精灵」（功能方案设计 4.2）：内联 SVG + CSS 类切换，零图片素材。
 * 两窗（待机窗 / 会话窗）共用本组件，避免两套形象漂移。动画只用
 * transform / opacity（常驻悬浮窗，不触发重排）；`prefers-reduced-motion`
 * 降级为静态形象（index.css 统一关掉动画）。
 */
export default function Pet({ state, audioLevel = 0, size = 36, className }: PetProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const level = Math.min(Math.max(audioLevel, 0), 1)
    rootRef.current?.style.setProperty('--pet-level', String(level))
  }, [audioLevel])

  return (
    <div
      ref={rootRef}
      className={cn('pet', `pet--${state}`, className)}
      style={
        {
          width: size,
          height: size,
          '--pet-level': '0',
        } as CSSProperties
      }
    >
      <svg viewBox="0 0 48 48" className="h-full w-full overflow-visible" aria-hidden="true">
        <g className="pet-sway">
          <g className="pet-breath">
            {/* 头顶新叶（品牌叶形呼应）：短茎 + 左右两片 */}
            <path
              d="M24 21 L24 13"
              stroke="oklch(0.6 0.15 138)"
              strokeWidth="2"
              strokeLinecap="round"
              fill="none"
            />
            <path
              className="pet-leaf"
              d="M23.2 13.5 C 19 7.5, 12 6, 10 9.5 C 8 13, 15 17, 23.2 13.5 Z"
              fill="oklch(0.62 0.15 138)"
            />
            <path
              className="pet-leaf pet-leaf--right"
              d="M24.8 12 C 28.2 6.8, 34.2 5.6, 35.8 8.8 C 37.4 12, 31 15.4, 24.8 12 Z"
              fill="oklch(0.66 0.15 133)"
            />
            {/* 身体 */}
            <ellipse cx="24" cy="31" rx="13.5" ry="12" fill="oklch(0.78 0.13 128)" />
            {/* 腮红 */}
            <circle className="pet-blush" cx="14.2" cy="33.6" r="2.5" fill="oklch(0.8 0.1 55)" />
            <circle className="pet-blush" cx="33.8" cy="33.6" r="2.5" fill="oklch(0.8 0.1 55)" />
            {/* 普通眼（idle / recording / processing） */}
            <g className="pet-eyes">
              <ellipse cx="18.4" cy="29" rx="2.3" ry="3" fill="oklch(0.23 0.03 140)" />
              <ellipse cx="29.6" cy="29" rx="2.3" ry="3" fill="oklch(0.23 0.03 140)" />
              <circle cx="17.6" cy="27.8" r="0.9" fill="oklch(0.97 0.01 140)" />
              <circle cx="28.8" cy="27.8" r="0.9" fill="oklch(0.97 0.01 140)" />
            </g>
            {/* 开心眯眯眼（success） */}
            <g className="pet-eyes-happy">
              <path
                d="M15.8 30.2 Q 18.4 26.6 21 30.2"
                stroke="oklch(0.23 0.03 140)"
                strokeWidth="2.2"
                strokeLinecap="round"
                fill="none"
              />
              <path
                d="M27 30.2 Q 29.6 26.6 32.2 30.2"
                stroke="oklch(0.23 0.03 140)"
                strokeWidth="2.2"
                strokeLinecap="round"
                fill="none"
              />
            </g>
            {/* 委屈垂眼（error） */}
            <g className="pet-eyes-sad">
              <path
                d="M15.8 27.6 L 21 30.4"
                stroke="oklch(0.23 0.03 140)"
                strokeWidth="2.2"
                strokeLinecap="round"
                fill="none"
              />
              <path
                d="M32.2 27.6 L 27 30.4"
                stroke="oklch(0.23 0.03 140)"
                strokeWidth="2.2"
                strokeLinecap="round"
                fill="none"
              />
            </g>
            {/* 嘴：常态椭圆（recording 由 --pet-level 张合）/ 微笑 / 撇嘴 */}
            <ellipse
              className="pet-mouth"
              cx="24"
              cy="35.4"
              rx="2.7"
              ry="1.7"
              fill="oklch(0.28 0.04 140)"
            />
            <path
              className="pet-mouth-smile"
              d="M20.4 34.6 Q 24 38.6 27.6 34.6"
              stroke="oklch(0.28 0.04 140)"
              strokeWidth="2.1"
              strokeLinecap="round"
              fill="none"
            />
            <path
              className="pet-mouth-frown"
              d="M21 37.4 Q 24 34.6 27 37.4"
              stroke="oklch(0.28 0.04 140)"
              strokeWidth="2.1"
              strokeLinecap="round"
              fill="none"
            />
          </g>
          {/* 思考点（processing）：右上三粒递进脉动 */}
          <g className="pet-dots">
            <circle cx="36.5" cy="16" r="1.5" fill="oklch(0.82 0.04 133)" />
            <circle cx="41" cy="12" r="1.5" fill="oklch(0.82 0.04 133)" />
            <circle cx="44.5" cy="7.5" r="1.5" fill="oklch(0.82 0.04 133)" />
          </g>
        </g>
      </svg>
    </div>
  )
}
