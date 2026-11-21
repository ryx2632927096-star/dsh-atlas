import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atlasRoot } from '../core/paths.js'

export function ledgerPath(root = atlasRoot()) {
  return join(root, 'patches', 'ledger.jsonl')
}

export function recordLedger(entry) {
  const root = entry?.root || atlasRoot()
  const file = ledgerPath(root)
  const line = JSON.stringify({
    at: Date.now(),
    atIso: new Date().toISOString(),
    patch: entry?.patch ?? null,
    action: entry?.action ?? 'unknown',
    result: entry?.result ?? 'unknown',
    detail: entry?.detail ? String(entry.detail).slice(0, 500) : null,
    pluginId: entry?.pluginId ?? null,
    upstreamVersion: entry?.upstreamVersion ?? null,
    anchorsHit: entry?.anchorsHit ?? null,
    generatedBy: entry?.generatedBy ?? 'atlas',
  })
  try {
    mkdirSync(join(root, 'patches'), { recursive: true })
    appendFileSync(file, line + '\n', 'utf8')
    return { ok: true, path: file }
  } catch (error) {
    return { ok: false, path: file, error: String(error?.message || error) }
  }
}

export function readLedger(options = {}) {
  const root = options.root || atlasRoot()
  const file = ledgerPath(root)
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : 30
  if (!existsSync(file)) return { total: 0, entries: [], brokenLines: 0 }

  let text
  try { text = readFileSync(file, 'utf8') } catch { return { total: 0, entries: [], brokenLines: 0 } }

  const entries = []
  let broken = 0
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    let rec
    try { rec = JSON.parse(raw) } catch { broken++; continue }
    if (options.patch && rec.patch !== options.patch) continue
    if (options.action && rec.action !== options.action) continue
    entries.push(rec)
  }
  entries.reverse()
  return { total: entries.length, entries: entries.slice(0, limit), brokenLines: broken }
}

export function ledgerSummary(options = {}) {
  const { entries } = readLedger({ ...options, limit: 100000 })
  const byPatch = new Map()
  for (const e of entries) {
    const id = e.patch || '(unknown)'
    const cur = byPatch.get(id)
    if (cur) { cur.count++; continue }
    byPatch.set(id, {
      patch: id,
      lastAction: e.action,
      lastResult: e.result,
      at: e.at,
      count: 1,
    })
  }
  return [...byPatch.values()]
}

export function renderLedger(summary, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : 20
  if (!summary.length) {
    return '台账还是空的。打完补丁、重放过、或跑一次巡检之后，这里就会出现流水记录。'
  }
  const lines = [`=== 补丁台账（${summary.length} 个补丁有流水）===`, '']
  for (const s of summary.slice(0, limit)) {
    const when = s.at ? new Date(s.at).toLocaleString('zh-CN') : '?'
    lines.push(`${s.patch}  →  ${s.lastAction}/${s.lastResult}（${when}，共 ${s.count} 条）`)
  }
  lines.push('', '台账是 append-only 的流水：声明改了不影响历史，历史也不会被改写。')
  return lines.join('\n')
}
