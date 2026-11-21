import { toolSurface } from './scan.js'

const FAMILIES = [
  { key: 'mcp', test: (n) => n.startsWith('mcp__') || n.startsWith('ws_mcp') },
  { key: 'memory', test: (n) => /^mnemon_|memory|recall|remember/.test(n) },
  { key: 'subagent', test: (n) => /subagent|squad|agent/.test(n) },
  { key: 'browser', test: (n) => n.startsWith('browser_') },
  { key: 'desktop', test: (n) => /^(screen_|app_|click|type|key|scroll)/.test(n) || n.startsWith('mcp__wincu') },
  { key: 'taskboard', test: (n) => n.startsWith('task_board') || n === 'team_comment' },
  { key: 'atlas', test: (n) => n.startsWith('atlas_') },
  { key: 'host', test: (n) => /^(pwsh|read|write|edit|glob|grep|run_code|job_|working_directory|load_workspace_dependencies|todo_write|skill|present|plan_|compact|set_|notify)/.test(n) },
  { key: 'goal', test: (n) => /goal/.test(n) },
  { key: 'remote', test: (n) => n.startsWith('remote_') },
  { key: 'session', test: (n) => /session_insights_|session/.test(n) },
  { key: 'misc', test: () => false },
]

export function familyOf(name) {
  for (const f of FAMILIES) if (f.test(name)) return f.key
  return 'other'
}

export function explainUnused(unusedRows, allRows, ownerOf = new Map()) {
  const out = new Map()

  const usedByPlugin = new Map()
  for (const r of allRows) {
    if (r.calls <= 0) continue
    const owner = ownerOf.get(r.name)
    if (!owner) continue
    const cur = usedByPlugin.get(owner) || { calls: 0, hotName: null, count: 0 }
    cur.calls += r.calls
    cur.count += 1
    if (!cur.hotName || r.calls > (cur.calls - r.calls)) cur.hotName = r.name
    usedByPlugin.set(owner, cur)
  }

  for (const r of unusedRows) {
    const owner = ownerOf.get(r.name) || null
    const plugin = owner ? usedByPlugin.get(owner) : null
    const pluginCalls = plugin?.calls || 0
    const pluginHotName = plugin?.hotName || null
    const pluginToolCount = plugin?.count || 0

    let hint
    if (!owner) {
      hint = '未识别归属（多半是宿主内置）。宿主工具按需才用，没调用过不构成问题，也不建议删。'
    } else if (pluginCalls === 0) {
      hint = `归属插件 ${owner} 的工具**一个都没用过** —— 这个插件你可能根本不需要，值得考虑停用`
    } else {
      hint = `归属插件 ${owner} 是活的（${pluginHotName} 等 ${pluginToolCount} 个工具共调用 ${pluginCalls} 次），`
        + '只是这一个没用到 —— 要么确实冗余，要么是还没遇到需要它的场景'
    }
    out.set(r.name, {
      family: familyOf(r.name),
      owner,
      pluginCalls,
      pluginHotName,
      pluginToolCount,
      hint,
    })
  }
  return out
}

export function analyzeSurface(db) {
  const rows = toolSurface(db)
  const hot = []
  const cold = []
  const unused = []
  const ghost = []
  for (const r of rows) {
    if (r.declared && r.calls >= 20) hot.push(r)
    else if (r.declared && r.calls > 0) cold.push(r)
    else if (r.declared && r.calls === 0) unused.push(r)
    else ghost.push(r)
  }
  const famMap = new Map()
  for (const r of rows) {
    const k = familyOf(r.name)
    const cur = famMap.get(k) || { family: k, total: 0, called: 0, unused: 0, calls: 0, errors: 0 }
    cur.total++
    cur.calls += r.calls
    cur.errors += r.errors
    if (r.calls > 0) cur.called++
    if (r.declared && r.calls === 0) cur.unused++
    famMap.set(k, cur)
  }
  return {
    totals: {
      surface: rows.length,
      hot: hot.length,
      cold: cold.length,
      unused: unused.length,
      ghost: ghost.length,
    },
    hot: hot.sort((a, b) => b.calls - a.calls),
    cold: cold.sort((a, b) => b.calls - a.calls),
    unused: unused.sort((a, b) => a.name.localeCompare(b.name)),
    ghost: ghost.sort((a, b) => b.calls - a.calls),
    families: [...famMap.values()].sort((a, b) => b.total - a.total),
    rows: rows.map((r) => ({ name: r.name, calls: r.calls || 0, sessions: r.sessions || 0 })),
  }
}

export function renderSurface(a, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(200, Math.floor(options.limit))) : 30
  const family = options.family || null
  const lines = []

  lines.push('=== 工具面总览 ===')
  lines.push(
    `宿主声明过 ${a.totals.surface} 个工具｜常用(≥20次) ${a.totals.hot}｜零星用过 ${a.totals.cold}` +
      `｜**声明但从未使用 ${a.totals.unused}**｜已下线但历史有调用 ${a.totals.ghost}`
  )
  lines.push('')

  if (!family) {
    lines.push('=== 按家族 ===')
    for (const f of a.families) {
      lines.push(
        `${f.family.padEnd(10)} 共 ${String(f.total).padStart(3)}｜用过 ${String(f.called).padStart(3)}` +
          `｜未用 ${String(f.unused).padStart(3)}｜累计调用 ${f.calls}` + (f.errors ? `｜报错 ${f.errors}` : '')
      )
    }
    lines.push('')
  }

  const pick = (arr) => (family ? arr.filter((r) => familyOf(r.name) === family) : arr)

  const unused = pick(a.unused)
  if (unused.length && options.showUnused !== false) {
    const allRows = [...a.hot, ...a.cold, ...a.unused, ...a.ghost]
    const explain = explainUnused(unused, allRows, options.ownerOf || new Map())
    lines.push(`=== 声明但从未使用（${unused.length} 个）=== `)
    lines.push('这些工具模型见过、但一次都没调用。下面每条都带「该不该用」的判据，不是空建议。')
    for (const r of unused.slice(0, limit)) {
      lines.push(`  · ${r.name}`)
      if (r.description) lines.push(`      ${String(r.description).replace(/\s+/g, ' ').slice(0, 110)}`)
      const e = explain.get(r.name)
      if (e) {
        lines.push(`      归属：${e.owner || '未识别（多半是宿主内置）'}`)
        lines.push(`      该不该用：${e.hint}`)
      }
    }
    if (unused.length > limit) lines.push(`  …其余 ${unused.length - limit} 个略`)
    lines.push('')
  }

  const hot = pick(a.hot)
  if (hot.length) {
    lines.push('=== 主力工具（调用 ≥20 次）===')
    for (const r of hot.slice(0, limit)) {
      lines.push(`  ${String(r.calls).padStart(6)}  ${r.name}` + (r.errors ? `（报错 ${r.errors}）` : ''))
    }
    lines.push('')
  }

  const cold = pick(a.cold)
  if (cold.length) {
    lines.push(`=== 零星用过（1~${19} 次，共 ${cold.length} 个）=== `)
    for (const r of cold.slice(0, limit)) {
      lines.push(`  ${String(r.calls).padStart(6)}  ${r.name}` + (r.errors ? `（报错 ${r.errors}）` : ''))
    }
    if (cold.length > limit) lines.push(`  …其余 ${cold.length - limit} 个略`)
    lines.push('')
  }

  const ghost = pick(a.ghost)
  if (ghost.length) {
    lines.push(`=== 未声明但有历史调用（${ghost.length} 个，多半插件已卸/改名）=== `)
    for (const r of ghost.slice(0, Math.min(limit, 20))) {
      lines.push(`  ${String(r.calls).padStart(6)}  ${r.name}`)
    }
    lines.push('')
  }

  lines.push('提示：这里只报事实（声明过 / 调过几次），不猜原因。要判断两个工具是否重复，用 atlas_overlap。')
  return lines.join('\n')
}
