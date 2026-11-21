import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { dshHome } from '../core/paths.js'

function skillDirs() {
  const out = []
  out.push({ dir: join(dshHome(), "skills"), origin: "local" })
  const roots = []
  if (process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, "Programs", "DeepSeek Harness"))
  roots.push("/Applications/DeepSeek Harness.app/Contents")
  roots.push("/opt/DeepSeek Harness")
  for (const r of roots) {
    const p = join(r, "resources", "runtime", "office-skills")
    if (existsSync(p)) { out.push({ dir: p, origin: "builtin" }); break }
  }
  return out
}

export function listSkills() {
  const seen = new Map()
  for (const { dir, origin } of skillDirs()) {
    if (!existsSync(dir)) continue
    let ents
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      if (!e.isDirectory()) continue
      if (seen.has(e.name)) continue
      const full = join(dir, e.name)
      const md = join(full, "SKILL.md")
      const hasMd = existsSync(md)
      let bytes = 0
      if (hasMd) { try { bytes = statSync(md).size } catch {   } }
      seen.set(e.name, { name: e.name, origin, hasSkillMd: hasMd, bytes })
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function skillUsage(db) {
  const byName = new Map()
  let totalCalls = 0
  let rows = []
  try {
    rows = db.prepare("SELECT session_id, time, summary, arg_shape FROM events WHERE type='tool/call' AND tool='skill'").all()
  } catch {
    return { byName, totalCalls: 0 }
  }

  for (const r of rows) {
    let name = null
    const m = /name\s*=\s*"([^"]+)"/.exec(String(r.arg_shape || ""))
    if (m) name = m[1]
    else if (r.summary && String(r.summary).trim()) name = String(r.summary).trim()
    if (!name) continue

    totalCalls += 1
    const cur = byName.get(name) || { calls: 0, sessions: new Set(), lastAt: 0 }
    cur.calls += 1
    if (r.session_id) cur.sessions.add(String(r.session_id))
    const t = Number(r.time)
    if (Number.isFinite(t) && t > cur.lastAt) cur.lastAt = t
    byName.set(name, cur)
  }
  return { byName, totalCalls }
}

export function analyzeSkills(skills, byName) {
  const list = Array.isArray(skills) ? skills : []
  const usage = byName instanceof Map ? byName : new Map()

  const items = list.map((s) => {
    const u = usage.get(s.name)
    return {
      name: s.name,
      origin: s.origin,
      hasSkillMd: s.hasSkillMd,
      bytes: s.bytes,
      calls: u ? u.calls : 0,
      sessions: u ? u.sessions.size : 0,
      lastAt: u ? u.lastAt : 0,
      used: Boolean(u && u.calls > 0),
    }
  })

  const known = new Set(list.map((s) => s.name))
  const orphanUsage = []
  for (const [name, u] of usage) {
    if (known.has(name)) continue
    orphanUsage.push({ name, calls: u.calls, sessions: u.sessions.size, lastAt: u.lastAt })
  }
  orphanUsage.sort((a, b) => b.calls - a.calls)

  items.sort((a, b) => {
    if (a.used !== b.used) return a.used ? -1 : 1
    if (b.calls !== a.calls) return b.calls - a.calls
    return a.name.localeCompare(b.name)
  })

  return {
    items,
    orphanUsage,
    summary: {
      total: items.length,
      used: items.filter((i) => i.used).length,
      unused: items.filter((i) => !i.used).length,
      local: items.filter((i) => i.origin === "local").length,
      builtin: items.filter((i) => i.origin === "builtin").length,
      missingSkillMd: items.filter((i) => !i.hasSkillMd).length,
    },
  }
}

export function renderSkills(analysis) {
  const lines = []
  const s = analysis.summary
  lines.push("=== 技能面 ===")
  lines.push("")
  lines.push(`共 ${s.total} 个技能（本地 ${s.local} + 内置 ${s.builtin}）`)
  lines.push(`用过 ${s.used} 个｜从没用过 ${s.unused} 个`)
  if (s.missingSkillMd) lines.push(`⚠ ${s.missingSkillMd} 个目录缺 SKILL.md（可能装坏了）`)
  lines.push("")

  if (s.used) {
    lines.push("--- 用过的 ---")
    for (const i of analysis.items.filter((x) => x.used)) {
      const when = i.lastAt ? new Date(i.lastAt).toLocaleString("zh-CN") : "?"
      lines.push(`  ${i.name}  ${i.calls} 次 / ${i.sessions} 个会话  最后 ${when}`)
    }
    lines.push("")
  }

  if (s.unused) {
    lines.push("--- 从没用过的 ---")
    for (const i of analysis.items.filter((x) => !x.used)) {
      const tag = i.origin === "builtin" ? "内置" : "本地"
      const bad = i.hasSkillMd ? "" : "  ⚠ 缺 SKILL.md"
      lines.push(`  ${i.name}  [${tag}]${bad}`)
    }
    lines.push("")
    lines.push("注意：「没用过」不等于「该删」。")
    lines.push("有些技能是备用场景（比如做 PPT、导出 PDF），平时不用是正常的。")
    lines.push("这里只报事实，不给删除建议。")
  }

  if (analysis.orphanUsage.length) {
    lines.push("")
    lines.push("--- 调用过但本机找不到定义的 ---")
    for (const o of analysis.orphanUsage) {
      lines.push(`  ${o.name}  ${o.calls} 次（可能装在别的 profile，或已删除）`)
    }
  }
  return lines.join("\n")
}
