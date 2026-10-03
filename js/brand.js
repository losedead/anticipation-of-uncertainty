// ─────────────────────────────────────────────────────────────
// 品牌图形：「不确定性锥」——左侧一个点代表此刻，向右展开成一束发散路径。
// 用 currentColor 描边，颜色由容器决定；不依赖任何外部图片。
// ─────────────────────────────────────────────────────────────
export const LOGOMARK = `<svg class="logomark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
  <g fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round">
    <path d="M9.9 16C15 11.2 18.4 8.2 24.8 5.2"/>
    <path d="M9.9 16h14.9"/>
    <path d="M9.9 16C15 20.8 18.4 23.8 24.8 26.8"/>
  </g>
  <circle cx="7" cy="16" r="2.8" fill="currentColor"/>
</svg>`

/**
 * 品牌块：图标 + 正名 + 一行副标。
 * @param {{ size?: 'sm'|'lg', sub?: string }} opts
 */
export function brandBlock({ size = 'sm', sub = 'UNCERTAINTY FORECASTING' } = {}) {
  return `<div class="brand brand-${size}">
      <span class="brand-mark">${LOGOMARK}</span>
      <span class="brand-text">
        <b>Anticipation of Uncertainty</b>
        <i>${sub}</i>
      </span>
    </div>`
}
