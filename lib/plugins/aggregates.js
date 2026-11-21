import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { safeFetchJson } from '../upstream/upstream.js'

export const KNOWN_AGGREGATES = [
  {
    aggregate: "zhu1090093659/dsh-web",
    satellites: [
      "zhu1090093659/dsh-skins",
      "zhu1090093659/dsh-pet",
      "zhu1090093659/dsh-community-plugins",
      "zhu1090093659/dsh-presets",
    ],
    evidence: ".gitmodules + market-inputs.lock.json",
  },
]

const discoveredRuntime = new Map()

export function registerDiscoveredAggregate(entry) {
  if (!entry || !entry.aggregate) return false
  discoveredRuntime.set(entry.aggregate, {
    aggregate: entry.aggregate,
    satellites: Array.isArray(entry.satellites) ? entry.satellites : [],
    evidence: entry.evidence || ".gitmodules",
  })
  return true
}

export function allAggregates() {
  const out = KNOWN_AGGREGATES.slice()
  for (const a of discoveredRuntime.values()) {
    if (!out.some((x) => x.aggregate === a.aggregate)) out.push(a)
  }
  return out
}

export function aggregateOf(fullName) {
  if (!fullName) return null
  for (const a of allAggregates()) {
    if (a.aggregate === fullName) return a
    if (a.satellites.indexOf(fullName) >= 0) return a
  }
  return null
}

export function upstreamWatchPlan(fullName) {
  const agg = aggregateOf(fullName)
  if (!agg) {
    return {
      role: "independent",
      watch: fullName ? [fullName] : [],
      note: "独立仓库，看它自己的 commit 就行",
    }
  }
  if (agg.aggregate === fullName) {
    return {
      role: "aggregate",
      watch: [agg.aggregate].concat(agg.satellites),
      note: "这是聚合仓库（证据：" + agg.evidence + "），它用子模块指针锁定 " + agg.satellites.length + " 个下游仓库；它发版时读的是指针那一刻的代码，所以下游改了自己的 main 不等于这里会变。",
    }
  }
  return {
    role: "satellite",
    watch: [agg.aggregate, fullName],
    note: "这个仓库被 " + agg.aggregate + " 当子模块聚合（证据：" + agg.evidence + "）；它自己更新后，还要等聚合体 bump 子模块指针才会被一起发布。",
  }
}


function cacheFile(root) {
  return join(root, "aggregate-cache.json")
}

export function readAggregateCache(root) {
  if (!root) return {}
  try {
    const j = JSON.parse(readFileSync(cacheFile(root), "utf8"))
    return j && typeof j === "object" ? j : {}
  } catch {
    return {}
  }
}

export function writeAggregateCache(root, cache) {
  if (!root) return false
  try {
    mkdirSync(root, { recursive: true })
    writeFileSync(cacheFile(root), JSON.stringify(cache, null, 1), "utf8")
    return true
  } catch {
    return false
  }
}

export function parseGitmodules(text) {
  const out = []
  if (typeof text !== "string") return out
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*url\s*=\s*(.+?)\s*$/.exec(line)
    if (!m) continue
    const url = m[1].trim().replace(/^git\+/, "").replace(/\.git$/, "")
    const gh = /github\.com[:/]([^/]+)\/([^/\s]+)/i.exec(url)
    if (gh) out.push(gh[1] + "/" + gh[2].replace(/\.git$/, ""))
  }
  return Array.from(new Set(out))
}

export async function detectAggregate(fullName, options = {}) {
  if (!fullName || !/^[\w.-]+\/[\w.-]+$/.test(fullName)) {
    return { aggregate: false, satellites: [], reason: "仓库名不合法" }
  }
  const api = "https://api.github.com/repos/" + fullName + "/contents/.gitmodules"
  try {
    const data = await safeFetchJson(api, { timeoutMs: options.timeoutMs || 15000 })
    if (!data || typeof data.content !== "string") {
      return { aggregate: false, satellites: [], reason: "响应里没有 content" }
    }
    const text = Buffer.from(data.content, data.encoding === "base64" ? "base64" : "utf8").toString("utf8")
    const satellites = parseGitmodules(text)
    if (!satellites.length) {
      return { aggregate: false, satellites: [], reason: "有 .gitmodules 但没解析出 GitHub 子模块" }
    }
    return { aggregate: true, satellites }
  } catch (error) {
    const msg = String((error && error.message) || error)
    if (/HTTP 404/.test(msg)) return { aggregate: false, satellites: [], reason: "没有 .gitmodules" }
    if (/HTTP 403/.test(msg)) return { aggregate: false, satellites: [], reason: "GitHub 配额用完（403）" }
    if (/超时|timeout|abort/i.test(msg)) return { aggregate: false, satellites: [], reason: "超时" }
    return { aggregate: false, satellites: [], reason: msg.slice(0, 120) }
  }
}

export async function discoverAggregates(fullNames, options = {}) {
  const root = options.root
  const maxAge = options.maxAgeMs || 7 * 24 * 3600 * 1000
  const budget = Number.isFinite(options.maxNetwork) ? options.maxNetwork : 8
  const force = Boolean(options.force)
  const cache = readAggregateCache(root)
  const now = Date.now()

  const discovered = []
  const errors = []
  let checked = 0
  let cached = 0

  const list = Array.from(new Set((Array.isArray(fullNames) ? fullNames : []).filter(Boolean)))
  for (const fullName of list) {
    if (checked >= budget) break
    if (aggregateOf(fullName)) continue

    const hit = cache[fullName]
    if (!force && hit && now - (hit.at || 0) < maxAge) {
      cached += 1
      if (hit.aggregate) {
        discovered.push({ aggregate: fullName, satellites: hit.satellites || [], evidence: ".gitmodules（缓存）" })
      }
      continue
    }

    const r = await detectAggregate(fullName, options)
    checked += 1
    cache[fullName] = { at: now, aggregate: r.aggregate, satellites: r.satellites, reason: r.reason || null }
    if (r.aggregate) {
      discovered.push({ aggregate: fullName, satellites: r.satellites, evidence: ".gitmodules（自动检测）" })
    } else if (r.reason && r.reason.indexOf("没有 .gitmodules") < 0) {
      errors.push(fullName + "：" + r.reason)
    }
  }

  for (const d of discovered) registerDiscoveredAggregate(d)
  if (checked) writeAggregateCache(root, cache)
  return { discovered, checked, cached, errors }
}
