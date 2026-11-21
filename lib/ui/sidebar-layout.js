
export const STYLE_ATTR = "data-dsh-atlas-sidebar"

export const LAYOUT_MODES = {
  normal: "标准（一列，拉多宽都不变）",
  grid: "多栏（按侧栏实际宽度自动排列）",
  icons: "只留图标（隐藏文字，图标放大，悬停显示名字）",
}

export const LEGACY_MODE_MAP = { grid2: "grid", grid3: "grid", collapsed: "normal" }

export function normalizeMode(raw) {
  const v = typeof raw === "string" ? raw : "normal"
  const mapped = LEGACY_MODE_MAP[v] || v
  return mapped === "icons" || mapped === "grid" ? mapped : "normal"
}

export function buildSidebarCss(opts = {}) {
  const mode = normalizeMode(opts.mode)
  const maxList = Number.isFinite(opts.maxListHeight)
    ? Math.max(120, Math.min(900, opts.maxListHeight))
    : 420

  const rules = []

  rules.push(`[class*="_panelList"] { max-height: ${maxList}px; overflow-y: auto; overflow-x: hidden; scrollbar-width: thin; }`)

  if (mode === "grid" || mode === "icons") {
    const minW = mode === "icons" ? 52 : 84
    rules.push(`[class*="_panelList"] {
      display: grid !important;
      flex-direction: row !important;
      grid-template-columns: repeat(auto-fit, minmax(${minW}px, 1fr)) !important;
      gap: 4px !important;
      align-content: start !important;
      align-items: stretch !important;
    }`)
    rules.push(`[class*="_panelList"] > * { min-width: 0 !important; }`)
  }

  if (mode === "icons") {
    rules.push(`[class*="_panelList"] [class*="_panelTitle"] { display: none !important; }`)
    rules.push(`[class*="_panelList"] > * { justify-content: center !important; padding-inline: 0 !important; min-height: 42px !important; border-radius: 8px !important; position: relative; }`)
    rules.push(`[class*="_panelList"] [class*="_panelGlyph"] {
      margin-inline: auto !important;
      font-size: 20px !important;
      line-height: 1 !important;
      width: 32px !important;
      height: 32px !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
    }`)

    rules.push(`[class*="_panelList"] > *:hover [class*="_panelTitle"] {
      display: block !important;
      position: fixed !important;
      z-index: 99999 !important;
      margin: 0 !important;
      padding: 4px 9px !important;
      border-radius: 6px !important;
      background: var(--dsw-alias-bg-elevated, #2b2b2b) !important;
      color: var(--dsw-alias-label-primary, #fff) !important;
      font-size: 12px !important;
      line-height: 1.4 !important;
      white-space: nowrap !important;
      pointer-events: none !important;
      box-shadow: 0 2px 10px rgba(0,0,0,.35) !important;
      transform: translateX(46px) translateY(2px) !important;
    }`)
  }

  return "/* dsh-atlas 侧栏布局 */\n" + rules.join("\n")
}
