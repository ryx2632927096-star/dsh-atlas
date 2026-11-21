import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { atlasRoot } from '../core/paths.js'

function correctionsFile(root = atlasRoot()) {
  return join(root, "upstream-corrections.jsonl")
}

export function reportBadLink(entry) {
  const root = entry && entry.root ? entry.root : atlasRoot()
  const file = correctionsFile(root)
  const line = JSON.stringify({
    at: Date.now(),
    atIso: new Date().toISOString(),
    pluginId: entry.pluginId || null,
    url: entry.url || null,
    reason: entry.reason || null,
    correctUrl: entry.correctUrl || null,
  })
  try {
    mkdirSync(root, { recursive: true })
    appendFileSync(file, line + "\n", "utf8")
    return { ok: true, path: file }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}

export function loadCorrections(root = atlasRoot()) {
  const file = correctionsFile(root)
  const out = new Map()
  if (!existsSync(file)) return out
  let text
  try { text = readFileSync(file, "utf8") } catch { return out }
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue
    let rec
    try { rec = JSON.parse(raw) } catch { continue }
    if (rec.pluginId && rec.correctUrl) out.set(rec.pluginId, rec.correctUrl)
    else if (rec.pluginId && !rec.correctUrl) out.set(rec.pluginId, "__REJECTED__")
  }
  return out
}

export function annotateReportable(plugins, byId, corrections) {
  const list = Array.isArray(plugins) ? plugins : []
  return list.map((p) => {
    const up = byId.get(p.id) || null
    const fixed = corrections && corrections.get(p.id)
    if (!up) return { id: p.id, upstream: null, reportable: false }

    if (fixed && fixed !== "__REJECTED__") {
      return {
        id: p.id,
        upstream: { ...up, url: fixed, source: "用户纠正", verified: true, note: "你在反馈里给出的地址" },
        reportable: false,
      }
    }
    if (fixed === "__REJECTED__") {
      return {
        id: p.id,
        upstream: { ...up, url: null, verified: false, note: "你反馈过这个链接不对，等一个新的正确地址" },
        reportable: false,
      }
    }

    const official = up.source === "package.json" || up.source === "插件市场目录"
    return { id: p.id, upstream: up, reportable: !official && up.url !== null }
  })
}
