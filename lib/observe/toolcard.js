import { classify } from './pitfalls.js'

export function summarizeArgs(argTexts, limit = 8) {
  const fieldCount = new Map()
  const valueSamples = new Map()

  for (const raw of argTexts) {
    let parsed
    try { parsed = JSON.parse(raw) } catch { continue }
    if (!parsed || typeof parsed !== 'object') continue
    for (const [key, value] of Object.entries(parsed)) {
      fieldCount.set(key, (fieldCount.get(key) || 0) + 1)
      if (typeof value === 'string' && value.length <= 60) {
        if (!valueSamples.has(key)) valueSamples.set(key, new Set())
        const set = valueSamples.get(key)
        if (set.size < 3) set.add(value)
      }
    }
  }

  return [...fieldCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({
      field: key,
      count,
      samples: [...(valueSamples.get(key) || [])],
    }))
}

export function fieldValueStats(shapes, field, limit = 8) {
  const counts = new Map()
  for (const shape of shapes) {
    if (!shape) continue
    const quoted = new RegExp(`${field}="([^"]*)"`).exec(shape)
    if (quoted) {
      const v = quoted[1]
      counts.set(v, (counts.get(v) || 0) + 1)
      continue
    }
    const plain = new RegExp(`(?:^|,\\s*)${field}:([^,]+)`).exec(shape)
    if (plain) {
      const v = plain[1].trim()
      counts.set(v, (counts.get(v) || 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }))
}

export function fieldNames(shapes, limit = 12) {
  const counts = new Map()
  for (const shape of shapes) {
    if (!shape) continue
    for (const m of shape.matchAll(/(?:^|,\s*)([A-Za-z_][A-Za-z0-9_]*)[:=]/g)) {
      counts.set(m[1], (counts.get(m[1]) || 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([field, count]) => ({ field, count }))
}

export function buildToolCard(db, toolName) {
  const calls = db.prepare(`
    SELECT seq, time, summary, arg_shape, session_id FROM events
    WHERE type='tool/call' AND tool=? ORDER BY time DESC
  `).all(toolName)

  if (!calls.length) return null

  const results = db.prepare(`
    SELECT is_error, seq, session_id, summary, duration_ms FROM events
    WHERE type='tool/result' AND tool=? ORDER BY time
  `).all(toolName)

  const errors = results.filter((r) => r.is_error === 1)
  const totalCalls = calls.length
  const totalResults = results.length
  const successRate = totalResults > 0
    ? ((totalResults - errors.length) / totalResults) * 100
    : null

  const errorBuckets = new Map()
  for (const e of errors) {
    const cat = classify(e.summary)
    const id = cat ? cat.id : '(未归类)'
    const name = cat ? cat.name : '未归类'
    if (!errorBuckets.has(id)) errorBuckets.set(id, { id, name, count: 0, severity: cat?.severity || 'unknown' })
    errorBuckets.get(id).count++
  }

  const shapes = calls.map((c) => c.arg_shape).filter(Boolean)
  const fieldStats = fieldNames(shapes).map(({ field, count }) => ({
    field,
    count,
    values: fieldValueStats(shapes, field, 5),
  }))

  const durationRows = results.filter((r) => typeof r.duration_ms === 'number' && r.duration_ms >= 0)
  let duration = null
  if (durationRows.length) {
    const sorted = durationRows.map((r) => r.duration_ms).sort((a, b) => a - b)
    const pick = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
    duration = {
      samples: sorted.length,
      min: sorted[0],
      p50: pick(0.5),
      p90: pick(0.9),
      max: sorted[sorted.length - 1],
    }
  }

  const NOISE = new Set(['pwsh', 'run_code'])
  const WINDOW_MS = 90 * 1000
  const companions = new Map()
  for (const call of calls.slice(0, 120)) {
    if (!call.time) continue
    const near = db.prepare(`
      SELECT tool, COUNT(*) AS n FROM events
      WHERE type='tool/call' AND tool IS NOT NULL AND tool != ?
        AND time BETWEEN ? AND ?
      GROUP BY tool
    `).all(toolName, call.time - WINDOW_MS, call.time + WINDOW_MS)
    for (const n of near) {
      if (NOISE.has(n.tool)) continue
      companions.set(n.tool, (companions.get(n.tool) || 0) + n.n)
    }
  }

  return {
    tool: toolName,
    totalCalls,
    totalResults,
    errors: errors.length,
    successRate,
    lastUsedAt: calls[0]?.time || null,
    errorBuckets: [...errorBuckets.values()].sort((a, b) => b.count - a.count),
    fieldStats,
    duration,
    companions: [...companions.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([t, n]) => ({ tool: t, together: n })),
    samples: errors.slice(0, 3).map((e) => String(e.summary || '').replace(/\s+/g, ' ').slice(0, 160)),
  }
}

export function listTools(db, limit = 60) {
  const rows = db.prepare(`
    SELECT
      c.tool AS tool,
      c.calls AS calls,
      COALESCE(r.results, 0) AS results,
      COALESCE(r.errors, 0) AS errors
    FROM (
      SELECT tool, COUNT(*) AS calls FROM events
      WHERE type='tool/call' AND tool IS NOT NULL GROUP BY tool
    ) c
    LEFT JOIN (
      SELECT tool,
             COUNT(*) AS results,
             SUM(CASE WHEN is_error=1 THEN 1 ELSE 0 END) AS errors
      FROM events WHERE type='tool/result' AND tool IS NOT NULL GROUP BY tool
    ) r ON r.tool = c.tool
    ORDER BY c.calls DESC
    LIMIT ?
  `).all(limit)

  return rows.map((r) => ({
    ...r,
    successRate: r.results > 0 ? ((r.results - r.errors) / r.results) * 100 : null,
  }))
}

export function renderToolCard(card) {
  const lines = []
  lines.push(`=== ${card.tool} ===`)
  const rate = card.successRate === null ? '无结果记录' : `${card.successRate.toFixed(1)}%`
  lines.push(`调用 ${card.totalCalls} 次｜有结果 ${card.totalResults} 次｜报错 ${card.errors} 次｜成功率 ${rate}`)

  if (card.duration) {
    const d = card.duration
    const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`)
    lines.push(`耗时：中位 ${fmt(d.p50)}｜p90 ${fmt(d.p90)}｜最长 ${fmt(d.max)}（${d.samples} 个样本）`)
  }
  if (card.lastUsedAt) lines.push(`最近使用：${new Date(card.lastUsedAt).toLocaleString('zh-CN')}`)
  lines.push('')

  if (card.fieldStats.length) {
    lines.push('实际怎么用（从历史调用统计）：')
    for (const f of card.fieldStats.slice(0, 6)) {
      if (f.values.length) {
        const vals = f.values.map((v) => (v.count > 1 ? `${v.value}×${v.count}` : v.value)).join(', ')
        lines.push(`  ${f.field} = ${vals.slice(0, 110)}`)
      } else {
        lines.push(`  ${f.field}（出现 ${f.count} 次）`)
      }
    }
    lines.push('')
  }

  if (card.errorBuckets.length) {
    lines.push('踩过的坑：')
    for (const b of card.errorBuckets) {
      lines.push(`  [${b.severity}] ${b.name} ×${b.count}`)
    }
    lines.push('')
  } else {
    lines.push('没有报错记录。')
    lines.push('')
  }

  if (card.companions.length) {
    lines.push('常搭配使用的工具（时间上紧邻）：')
    for (const c of card.companions) {
      lines.push(`  ${c.tool}  ×${c.together}`)
    }
    lines.push('')
  }

  if (card.samples.length) {
    lines.push('报错样例：')
    for (const s of card.samples) lines.push(`  ${s.slice(0, 140)}`)
  }

  return lines.join('\n')
}

export function renderToolList(tools) {
  const lines = ['=== 工具使用排行 ===', '']
  lines.push('调用数  成功率   报错   工具')
  for (const t of tools) {
    const rate = t.successRate === null ? '   —  ' : `${t.successRate.toFixed(1)}%`.padStart(6)
    lines.push(`${String(t.calls).padStart(6)}  ${rate}  ${String(t.errors).padStart(4)}   ${t.tool}`)
  }
  return lines.join('\n')
}
