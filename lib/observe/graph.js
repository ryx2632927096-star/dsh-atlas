import { classify } from './pitfalls.js'

const WINDOW_MS = 90 * 1000
const NOISE = new Set(['pwsh', 'run_code'])

export function buildGraph(db, options = {}) {
  const windowMs = options.windowMs || WINDOW_MS
  const minCount = options.minCount || 3

  const calls = db.prepare(`
    SELECT tool, time, session_id FROM events
    WHERE type='tool/call' AND tool IS NOT NULL AND time IS NOT NULL
    ORDER BY time
  `).all()

  const rateRows = db.prepare(`
    SELECT tool,
           COUNT(*) AS results,
           SUM(CASE WHEN is_error=1 THEN 1 ELSE 0 END) AS errors
    FROM events WHERE type='tool/result' AND tool IS NOT NULL
    GROUP BY tool
  `).all()
  const rateByTool = new Map(rateRows.map((r) => [r.tool, {
    results: r.results,
    errors: r.errors,
    successRate: r.results > 0 ? ((r.results - r.errors) / r.results) * 100 : null,
  }]))

  const edges = new Map()
  for (let i = 0; i < calls.length; i++) {
    const a = calls[i]
    if (NOISE.has(a.tool)) continue
    for (let j = i + 1; j < calls.length; j++) {
      const b = calls[j]
      const gap = b.time - a.time
      if (gap > windowMs) break
      if (b.session_id !== a.session_id) continue
      if (b.tool === a.tool || NOISE.has(b.tool)) continue
      const key = `${a.tool}\u0000${b.tool}`
      if (!edges.has(key)) edges.set(key, { from: a.tool, to: b.tool, count: 0 })
      edges.get(key).count++
      break
    }
  }

  const list = [...edges.values()]
    .filter((e) => e.count >= minCount)
    .map((e) => ({
      ...e,
      toRate: rateByTool.get(e.to)?.successRate ?? null,
      toErrors: rateByTool.get(e.to)?.errors ?? 0,
    }))
    .sort((a, b) => b.count - a.count)

  return { edges: list, windowMs, minCount, callCount: calls.length }
}

export function findChains(graph, options = {}) {
  const minRate = options.minRate ?? 90
  const minSamples = options.minSamples ?? 5
  return graph.edges
    .filter((e) => e.toRate !== null && e.toRate >= minRate && e.count >= minSamples)
    .map((e) => ({
      chain: `${e.from} → ${e.to}`,
      count: e.count,
      successRate: e.toRate,
    }))
}

export function findAntiPatterns(graph, options = {}) {
  const maxRate = options.maxRate ?? 70
  return graph.edges
    .filter((e) => e.toRate !== null && e.toRate < maxRate)
    .map((e) => ({
      chain: `${e.from} → ${e.to}`,
      count: e.count,
      successRate: e.toRate,
      errors: e.toErrors,
    }))
}

export function renderGraph(graph, extra = {}) {
  const lines = []
  lines.push('=== 工具协同图谱 ===')
  lines.push(`分析窗口 ${graph.windowMs / 1000}s｜最小样本 ${graph.minCount}｜共 ${graph.callCount} 次调用`)
  lines.push('')

  lines.push('最强链路（A 之后紧接 B 的频次）：')
  for (const e of graph.edges.slice(0, 12)) {
    const rate = e.toRate === null ? '  —  ' : `${e.toRate.toFixed(1)}%`
    lines.push(`  ${String(e.count).padStart(4)}×  ${e.from} → ${e.to}   (${e.to} 成功率 ${rate})`)
  }

  if (extra.chains?.length) {
    lines.push('')
    lines.push(`✅ 推荐链路（后继工具成功率 ≥ ${extra.chains[0].successRate >= 95 ? '95' : '90'}%）：`)
    for (const c of extra.chains.slice(0, 8)) {
      lines.push(`  ${c.chain}   ${c.successRate.toFixed(1)}%  ×${c.count}`)
    }
  }

  if (extra.antiPatterns?.length) {
    lines.push('')
    lines.push('⚠️ 反模式（后继工具成功率偏低）：')
    for (const a of extra.antiPatterns.slice(0, 8)) {
      lines.push(`  ${a.chain}   ${a.successRate.toFixed(1)}%  报错 ${a.errors} 次`)
    }
  }

  return lines.join('\n')
}

export function renderMcpRecipe(db) {
  const lines = ['=== MCP 工具调用套路 ===', '']
  const seq = ['ws_mcp_list', 'ws_mcp_search', 'ws_mcp_detail', 'ws_mcp_call']
  for (const name of seq) {
    const r = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM events WHERE type='tool/call' AND tool=?) AS calls,
        (SELECT COUNT(*) FROM events WHERE type='tool/result' AND tool=? AND is_error=1) AS errors,
        (SELECT COUNT(*) FROM events WHERE type='tool/result' AND tool=?) AS results
    `).get(name, name, name)
    const rate = r.results > 0 ? (((r.results - r.errors) / r.results) * 100).toFixed(1) + '%' : '—'
    lines.push(`  ${name.padEnd(16)} 调用 ${String(r.calls).padStart(4)}  成功率 ${rate}`)
  }
  lines.push('')
  lines.push('标准顺序：列表确认名字 → 搜索关键词 → 查 schema → 按 schema 调用')
  lines.push('关键：server 参数写 @<root>/<server>，名字从 ws_mcp_list 抄，不要用内部 id。')

  const errs = db.prepare(`
    SELECT summary FROM events
    WHERE type='tool/result' AND tool LIKE 'ws_mcp%' AND is_error=1
  `).all()
  const buckets = new Map()
  for (const e of errs) {
    const c = classify(e.summary)
    if (!c) continue
    buckets.set(c.name, (buckets.get(c.name) || 0) + 1)
  }
  if (buckets.size) {
    lines.push('')
    lines.push('这一族踩过的坑：')
    for (const [name, n] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${name} ×${n}`)
    }
  }
  return lines.join('\n')
}
