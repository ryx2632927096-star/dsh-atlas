import { checkAllPatches } from '../patches/patches.js'
import { listSnapshots } from '../patches/snapshot.js'
import { summary, openDb, toolSurface } from '../observe/scan.js'
import { listTools } from '../observe/toolcard.js'
import { buildPitfalls } from '../observe/pitfalls.js'
import { buildGraph, findChains, findAntiPatterns } from '../observe/graph.js'
import { discoverPlugins } from '../plugins/plugins.js'
import { groupFamilies, summarizeFamilies } from '../plugins/families.js'
import { attributeTools } from '../plugins/attribution.js'
import { collectLayers, findOverlaps } from '../plugins/layers.js'
import { readProfileState, buildRemediationPlan } from '../plugins/remediate.js'
import { readLedger, ledgerSummary } from '../patches/ledger.js'
import { analyzeSurface } from '../observe/surface.js'
import { listSkills, skillUsage, analyzeSkills } from '../observe/skills.js'
import { groupByPlugin } from '../observe/surface-groups.js'
import { scanLocalModifications } from '../patches/drift.js'
import { patrolDueInfo, readPatrolState } from '../upstream/patrol.js'
import { loadDependencies } from '../update/update.js'
import { join, dirname as pathDirname } from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync, readFileSync, readdirSync } from "node:fs"

const PLUGIN_PKG_ROOT = pathDirname(pathDirname(pathDirname(fileURLToPath(import.meta.url))))

function pluginPatchDir() {
  return PLUGIN_PKG_ROOT
}
import { atlasRoot, dshHome } from '../core/paths.js'
import { MODEL_SLOTS } from '../ai/models.js'
import { collectSidebarEntries, summarizeSidebar } from './sidebar.js'
import { enrichUpstream } from '../upstream/upstream-links.js'
import { listBuiltinPlugins } from '../observe/builtin.js'
import { loadCorrections, annotateReportable, reportBadLink } from '../upstream/upstream-feedback.js'
import { writeModelSlot, readModelsSection } from '../core/config-write.js'
import { loadMarketPatchApi, locatePatchFile, readToggleState, setPluginEnabled } from '../plugins/plugin-toggle.js'
import { backupBeforeWrite } from '../patches/auto-backup.js'

const ROUTE_PREFIX = "/dsh-atlas-api"
const VERSION = 2

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  })
  res.end(body)
}

function sameOriginOk(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const o = new URL(origin)
    return o.hostname === "127.0.0.1" || o.hostname === "localhost" || o.hostname === "[::1]"
  } catch {
    return false
  }
}

function hostIsLoopback(req) {
  const host = String(req.headers.host || "").toLowerCase()
  const name = host.split(":")[0]
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]" || name === "::1"
}

const CACHE = new Map()
function cached(key, ttlMs, compute) {
  const now = Date.now()
  const hit = CACHE.get(key)
  if (hit && now - hit.at < ttlMs) return hit.value
  const value = compute()
  CACHE.set(key, { at: now, value })
  for (const [k, v] of CACHE) if (now - v.at > ttlMs * 10) CACHE.delete(k)
  return value
}

export function invalidateApiCache() {
  CACHE.clear()
}

function safe(label, fn) {
  try {
    return { ok: true, value: fn() }
  } catch (error) {
    return { ok: false, error: label + ": " + String((error && error.message) || error).slice(0, 200) }
  }
}

function buildOverview(root) {
  const out = { version: VERSION, generatedAt: Date.now(), errors: [] }

  out.pluginScopeNote =
    "只统计本机已安装的插件（profile 的 node_modules）。"
    + "插件市场里那 106 条是「可以装的」，不是「已经装的」；"
    + "DSH 自带的官方 bundle 打包在宿主内部，读不到文件，也没有独立的 npm 包。"

  const p = safe("补丁", () => {
    const r = checkAllPatches(root)
    return {
      summary: r.summary,
      items: r.results.map((x) => ({
        id: (x.patch && x.patch.id) || "(未知)",
        name: (x.patch && x.patch.name) || "",
        severity: (x.patch && x.patch.severity) || "unknown",
        status: x.status,
        detail: x.detail,
        manual: x.patch && x.patch.manual === true,
        target: (x.patch && x.patch.target) || null,
      })),
    }
  })
  if (p.ok) out.patches = p.value; else out.errors.push(p.error)

  const s = safe("快照", () => listSnapshots(root).slice(0, 6).map((x) => ({
    name: x.name, at: x.at, label: x.label, files: (x.files && x.files.length) || 0,
  })))
  out.snapshots = s.ok ? s.value : []
  if (!s.ok) out.errors.push(s.error)

  const dbRes = safe("索引", () => openDb(root))
  if (dbRes.ok) {
    const db = dbRes.value
    try {
      const idx = safe("索引概况", () => summary(root).totals)
      out.index = idx.ok ? idx.value : null
      const tl = safe("工具画像", () => listTools(db, 20).map((t) => ({
        tool: t.tool, calls: t.calls, errors: t.errors, successRate: t.successRate,
      })))
      out.tools = tl.ok ? tl.value : []
      const sf = safe("工具面", () => {
        const a = analyzeSurface(db)
        return {
          totals: a.totals,
          families: a.families,
          unused: a.unused.slice(0, 40).map((r) => ({ name: r.name, description: r.description })),
          rows: a.rows ? a.rows.map((r) => ({ name: r.name, calls: r.calls || 0, sessions: r.sessions || 0 })) : [],
        }
      })
      out.surface = sf.ok ? sf.value : null

      const sk = safe("技能面", () => {
        const usage = skillUsage(db)
        return analyzeSkills(listSkills(), usage.byName)
      })
      out.skills = sk.ok ? sk.value : null

      if (sf.ok) {
        const at2 = safe("工具归属映射", () => {
          const db2 = openDb(root)
          try { return attributeTools(discoverPlugins({}).plugins, sf.value.rows.map((r) => r.name)) } finally { try { db2.close() } catch {   } }
        })
        const ownerMap = new Map()
        if (at2.ok && at2.value && Array.isArray(at2.value.owners)) {
          for (const o of at2.value.owners) ownerMap.set(o.tool, o.pluginId)
        }
        const gp = safe("按插件分组", () => groupByPlugin(sf.value.rows, ownerMap))
        out.toolGroups = gp.ok ? gp.value : null
      }
      const pf = safe("踩坑库", () => {
        const x = buildPitfalls(db)
        return {
          total: x.total, matched: x.matched,
          buckets: x.buckets.slice(0, 12).map((b) => ({
            id: b.id, name: b.name, severity: b.severity, count: b.count,
            cause: b.cause, fix: b.fix, tools: b.tools,
          })),
        }
      })
      out.pitfalls = pf.ok ? pf.value : null
      const gf = safe("协同图谱", () => {
        const g = buildGraph(db)
        return {
          callCount: g.callCount,
          edges: g.edges.slice(0, 15).map((e) => ({ from: e.from, to: e.to, count: e.count, toRate: e.toRate })),
          chains: findChains(g).slice(0, 6),
          antiPatterns: findAntiPatterns(g).slice(0, 6),
        }
      })
      out.graph = gf.ok ? gf.value : null
    } finally {
      try { db.close() } catch {   }
    }
  } else {
    out.errors.push(dbRes.error)
  }

  return out
}

function buildPlugins(root) {
  const out = { version: VERSION, generatedAt: Date.now(), errors: [] }
  const d = safe("插件发现", () => discoverPlugins({}))
  if (!d.ok) { out.errors.push(d.error); return out }
  const list = d.value.plugins || []
  out.total = list.length

  let upstreamById = new Map()
  try {
    const nmDir = join(dshHome(), "profiles", "desktop", "node_modules")
    const { byId, stats } = enrichUpstream(list, nmDir)
    upstreamById = byId
    out.upstreamStats = stats
  } catch (error) {
    out.errors.push("上游链接补全失败：" + String((error && error.message) || error).slice(0, 160))
  }

  let corrections = new Map()
  try { corrections = loadCorrections(root) } catch {   }
  let annotated = new Map()
  try {
    const rows = annotateReportable(list, upstreamById, corrections)
    for (const r of rows) annotated.set(r.id, r)
  } catch (error) {
    out.errors.push("链接反馈标注失败：" + String((error && error.message) || error).slice(0, 120))
  }
  out.counts = list.reduce((m, x) => { m[x.sourceType] = (m[x.sourceType] || 0) + 1; return m }, {})

  const decl = safe("工具面", () => {
    const db = openDb(root)
    try { return toolSurface(db) } finally { try { db.close() } catch {   } }
  })
  const names = decl.ok ? decl.value.map((r) => r.name) : []

  const at = safe("工具归属", () => attributeTools(list, names))
  const byPlugin = new Map()
  if (at.ok) {
    for (const o of at.value.owners) {
      if (!byPlugin.has(o.pluginId)) byPlugin.set(o.pluginId, [])
      byPlugin.get(o.pluginId).push(o.tool)
    }
  }

  out.plugins = list.map((x) => {
    const m = safe("本地改动 " + x.id, () => {
      const r = scanLocalModifications(x)
      return {
        files: (r.modified || []).filter((y) => y.reason === "nlink-1").map((y) => y.file),
        reason: r.reason || null,
      }
    })
    return {
      id: x.id,
      version: x.version,
      sourceType: x.sourceType,
      repo: x.repo || null,
      repoUrl: x.repoUrl,
      description: x.description || "",
      upstream: (annotated.get(x.id) || {}).upstream || upstreamById.get(x.id) || null,
      reportable: Boolean((annotated.get(x.id) || {}).reportable),
      isSelf: x.isSelf,
      inBundles: x.inBundles,
      bundleOrder: x.bundleOrder,
      patchIds: x.patchIds || [],
      tools: byPlugin.get(x.id) || [],
      modified: m.ok ? m.value : { files: [], reason: null },
    }
  })

  out.attribution = at.ok
    ? { owned: at.value.owners.length, ambiguous: at.value.ambiguous.length, unattributed: at.value.unattributed.length, scannedFiles: at.value.scannedFiles }
    : null
  out.ambiguous = at.ok ? at.value.ambiguous.slice(0, 20) : []
  out.unattributed = at.ok ? at.value.unattributed.slice(0, 40) : []

  try {
    const g = groupFamilies(out.plugins)
    out.families = g.families
    out.dependencies = g.dependencies || []
    out.familySummary = summarizeFamilies(g.families, g.dependencies)
  } catch (error) {
    out.families = []
    out.familySummary = null
    out.errors.push("插件家族分组失败：" + String((error && error.message) || error).slice(0, 160))
  }
  return out
}

function buildLayers() {
  const out = { version: VERSION, generatedAt: Date.now(), errors: [] }
  const l = safe("层收集", () => collectLayers({}))
  if (!l.ok) { out.errors.push(l.error); return out }
  const items = l.value.items || []
  out.warnings = l.value.warnings || []
  out.items = items.map((i) => ({
    layer: i.layer, backendId: i.backendId, pluginId: i.pluginId,
    storePath: i.storePath, scope: i.scope, active: i.active, detail: i.detail,
    readApi: i.readApi, writeApi: i.writeApi,
  }))

  const ov = safe("重叠判定", () => findOverlaps(items))
  out.overlaps = ov.ok
    ? ov.value.map((o) => ({
        layer: o.layer, a: o.a, b: o.b, kind: o.kind, verdict: o.verdict, score: o.score,
        evidence: (o.evidence || []).slice(0, 4),
      }))
    : []
  if (!ov.ok) out.errors.push(ov.error)

  const ps = safe("profile", () => readProfileState())
  const psv = ps.ok ? ps.value : null
  out.profile = psv
    ? { bundles: psv.bundles.length, dependencies: psv.dependencies.length, patchIds: psv.patchIds.length }
    : null

  const rm = safe("净化方案", () => buildRemediationPlan(out.overlaps, { profileState: psv }))
  out.remediation = rm.ok ? rm.value : { plans: [], withheld: [], notes: [] }
  if (!rm.ok) out.errors.push(rm.error)
  return out
}

function buildOps(root, models, options = {}) {
  const out = { version: VERSION, generatedAt: Date.now(), errors: [] }

  if (models && models.slots) {
    out.models = Object.keys(MODEL_SLOTS).map((key) => {
      const s = models.slots[key]
      return {
        key,
        desc: MODEL_SLOTS[key],
        followsDefault: s.followsDefault,
        label: s.followsDefault
          ? "跟随默认模型"
          : (s.provider ? s.provider + "/" : "") + s.model + (s.reasoningEffort ? "（" + s.reasoningEffort + "）" : ""),
      }
    })
    out.modelWarnings = models.warnings || []
    out.modelConfigTarget = join(pluginPatchDir(), "cordis.patch.yml")
  } else {
    out.models = []
  }
  const s = safe("台账", () => ledgerSummary({ root }))
  out.ledger = s.ok ? s.value.slice(0, 40) : []
  const t = safe("台账明细", () => readLedger({ root, limit: 30 }))
  out.ledgerTail = t.ok ? t.value : { entries: [], total: 0 }
  const due = safe("巡检状态", () => patrolDueInfo(root, 24))
  out.patrol = due.ok ? due.value : null
  const st = safe("巡检 state", () => readPatrolState(root))
  out.patrolState = st.ok ? st.value : null

  const upd = safe("更新清单", () => {
    const deps = loadDependencies()
    if (!deps.ok) return null
    return {
      updatable: deps.updatable,
      linked: deps.linked,
      profileDir: deps.profileDir,
    }
  })
  out.update = upd.ok ? upd.value : null
  if (!upd.ok) out.errors.push(upd.error)

  out.modelService = typeof options.llmReady === "function" ? options.llmReady() : null

  const sb = safe("侧栏清单", () => collectSidebarEntries())
  out.sidebar = sb.ok ? sb.value : []
  out.sidebarSummary = sb.ok ? summarizeSidebar(sb.value) : null
  if (!sb.ok) out.errors.push(sb.error)

  return out
}

export function registerRoutes(ctx, options = {}) {
  const models = options.models || null
  let webServer = null
  try {
    webServer = (ctx && ctx.webServer) || (ctx && typeof ctx.get === "function" ? ctx.get("webServer") : null) || null
  } catch { webServer = null }
  if (!webServer || typeof webServer.register !== "function") {
    return { ok: false, reason: "webServer 服务不可用（ctx.get 也取不到）" }
  }

  const root = atlasRoot()
  const results = {}

  const route = (name, path, handler) => {
    try {
      const dispose = webServer.register({
        kind: "exact",
        path: path,
        handler: function (req, res) {
          try {
            const g = globalThis
            if (!g.__atlasApiHitLogged) {
              g.__atlasApiHitLogged = true
              const traceFn = g.__atlasTrace
              if (typeof traceFn === "function") traceFn("api-first-hit", path)
            }
          } catch {   }
          if (!sameOriginOk(req) || !hostIsLoopback(req)) return json(res, 403, { error: "只接受本机回环请求" })
          if (String(req.method || "GET").toUpperCase() !== "GET") return json(res, 405, { error: "只读接口" })
          try {
            json(res, 200, handler())
          } catch (error) {
            json(res, 500, { error: String((error && error.message) || error).slice(0, 300) })
          }
        },
      })
      if (ctx && typeof ctx.effect === "function" && typeof dispose === "function") {
        try { ctx.effect(() => dispose) } catch {   }
      }
      results[name] = true
      return true
    } catch (error) {
      try { console.error("[dsh-atlas] 路由 " + path + " 注册失败：" + String((error && error.message) || error)) } catch {   }
      results[name] = false
      return false
    }
  }

  route("overview", ROUTE_PREFIX + "/overview", () => cached("overview", 60000, () => buildOverview(root)))
  route("plugins", ROUTE_PREFIX + "/plugins", () => cached("plugins", 120000, () => buildPlugins(root)))
  route("layers", ROUTE_PREFIX + "/layers", () => cached("layers", 60000, () => buildLayers()))
  route("ops", ROUTE_PREFIX + "/ops", () => cached("ops", 15000, () => buildOps(root, models, options)))

  route("health", ROUTE_PREFIX + "/health", () => cached("health", 60000, () => {
    const out = { version: VERSION, generatedAt: Date.now(), errors: [] }
    try {
      const prof = join(dshHome(), "profiles", "desktop")
      const pkgFile = join(prof, "package.json")
      const patchFile = join(prof, "cordis.patch.yml")

      out.profileDir = prof
      out.packageJsonOk = false
      out.bundles = 0
      out.dependencies = 0
      if (existsSync(pkgFile)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgFile, "utf8"))
          out.packageJsonOk = true
          out.dependencies = Object.keys(pkg.dependencies || {}).length
          out.bundles = ((pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || []).length
        } catch (e) {
          out.errors.push("package.json 解析失败：" + String(e.message).slice(0, 120))
        }
      }
      out.patchFileExists = existsSync(patchFile)
      try {
        out.backupCount = readdirSync(prof).filter((n) => /\.bak([-.].*)?$/.test(n)).length
      } catch { out.backupCount = 0 }
      out.rescueHint = "在插件目录 " + PLUGIN_PKG_ROOT + " 中执行 node rescue.mjs check"
    } catch (e) {
      out.errors.push(String((e && e.message) || e).slice(0, 160))
    }
    return out
  }))

  route("builtin", ROUTE_PREFIX + "/builtin", () => cached("builtin", 300000, () => {
    const r = listBuiltinPlugins()
    return {
      version: VERSION,
      generatedAt: Date.now(),
      errors: r.error ? [r.error] : [],
      asar: r.asar,
      counts: r.counts,
      plugins: (r.builtin || []).map((x) => ({
        id: x.id,
        shortName: x.shortName,
        kind: x.kind,
      })),
    }
  }))

  try {
    const dispose = webServer.register({
      kind: "exact",
      path: ROUTE_PREFIX + "/report-link",
      handler(req, res) {
        if (!sameOriginOk(req) || !hostIsLoopback(req)) return json(res, 403, { error: "只接受本机回环请求" })
        if (String(req.method || "GET").toUpperCase() !== "POST") return json(res, 405, { error: "只接受 POST" })
        let body = ""
        let tooBig = false
        req.on("data", (c) => { body += c; if (body.length > 8192) { tooBig = true; req.destroy() } })
        req.on("end", () => {
          if (tooBig) return json(res, 413, { error: "请求过大" })
          let payload = null
          try { payload = JSON.parse(body) } catch { return json(res, 400, { error: "不是合法 JSON" }) }
          const r = reportBadLink({
            root,
            pluginId: typeof payload.pluginId === "string" ? payload.pluginId.slice(0, 200) : null,
            url: typeof payload.url === "string" ? payload.url.slice(0, 500) : null,
            reason: typeof payload.reason === "string" ? payload.reason.slice(0, 500) : null,
            correctUrl: typeof payload.correctUrl === "string" ? payload.correctUrl.slice(0, 500) : null,
          })
          json(res, r.ok ? 200 : 500, r.ok ? { status: "recorded" } : { error: r.error })
        })
        req.on("error", () => json(res, 400, { error: "读取请求失败" }))
      },
    })
    if (typeof ctx?.effect === "function" && typeof dispose === "function") {
      try { ctx.effect(() => dispose) } catch {   }
    }
    results["report-link"] = true
  } catch (error) {
    try { console.error("[dsh-atlas] 反馈路由注册失败：" + String((error && error.message) || error)) } catch {   }
    results["report-link"] = false
  }

  try {
    const dispose = webServer.register({
      kind: "exact",
      path: ROUTE_PREFIX + "/config/models",
      handler(req, res) {
        if (!sameOriginOk(req) || !hostIsLoopback(req)) return json(res, 403, { error: "只接受本机回环请求" })
        if (String(req.method || "GET").toUpperCase() === "GET") {
          const target = pluginPatchDir()
          const sec = readModelsSection(target)
          return json(res, 200, { ok: true, target: join(target, "cordis.patch.yml"), found: sec.found, text: sec.text })
        }
        if (String(req.method || "GET").toUpperCase() !== "POST") return json(res, 405, { error: "只接受 GET / POST" })
        let body = ""
        let tooBig = false
        req.on("data", (c) => { body += c; if (body.length > 8192) { tooBig = true; req.destroy() } })
        req.on("end", () => {
          if (tooBig) return json(res, 413, { error: "请求过大" })
          let p = null
          try { p = JSON.parse(body) } catch { return json(res, 400, { error: "不是合法 JSON" }) }
          const r = writeModelSlot({
            pkgDir: pluginPatchDir(),
            slot: typeof p.slot === "string" ? p.slot.slice(0, 60) : "",
            provider: typeof p.provider === "string" ? p.provider.slice(0, 120) : null,
            model: typeof p.model === "string" ? p.model.slice(0, 120) : null,
            reasoningEffort: typeof p.reasoningEffort === "string" ? p.reasoningEffort.slice(0, 60) : null,
          })
          invalidateApiCache()
          json(res, r.ok ? 200 : 400, r.ok
            ? { status: "written", backup: r.backup ? String(r.backup).split(/[\\/]/).pop() : null }
            : { error: r.reason })
        })
        req.on("error", () => json(res, 400, { error: "读取请求失败" }))
      },
    })
    if (typeof ctx?.effect === "function" && typeof dispose === "function") {
      try { ctx.effect(() => dispose) } catch {   }
    }
    results["config-models"] = true
  } catch (error) {
    try { console.error("[dsh-atlas] 配置写回路由注册失败：" + String((error && error.message) || error)) } catch {   }
    results["config-models"] = false
  }

  try {
    const dispose = webServer.register({
      kind: "exact",
      path: ROUTE_PREFIX + "/toggle-plugin",
      handler(req, res) {
        if (!sameOriginOk(req) || !hostIsLoopback(req)) return json(res, 403, { error: "只接受本机回环请求" })
        const method = String(req.method || "GET").toUpperCase()

        if (method === "GET") {
          ;(async () => {
            try {
              const api = await loadMarketPatchApi()
              const patchFile = locatePatchFile(null)
              const list = discoverPlugins({}).plugins.map((p) => {
                const st = readToggleState({ patchFile, rowId: p.id, api: api && api.mod })
                return { id: p.id, known: st.known, disabled: Boolean(st.disabled) }
              })
              json(res, 200, {
                ok: true,
                patchFile,
                via: api ? "dshmarket" : "fallback",
                items: list,
              })
            } catch (error) {
              json(res, 500, { error: String((error && error.message) || error).slice(0, 200) })
            }
          })()
          return
        }

        if (method !== "POST") return json(res, 405, { error: "只接受 GET / POST" })

        let body = ""
        let tooBig = false
        req.on("data", (c) => { body += c; if (body.length > 8192) { tooBig = true; req.destroy() } })
        req.on("end", () => {
          if (tooBig) return json(res, 413, { error: "请求过大" })
          let payload = null
          try { payload = JSON.parse(body) } catch { return json(res, 400, { error: "不是合法 JSON" }) }

          const pluginId = typeof payload.pluginId === "string" ? payload.pluginId.trim() : ""
          const disable = payload.disable === true
          if (!pluginId) return json(res, 400, { error: "缺少 pluginId" })
          if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(pluginId)) return json(res, 400, { error: "插件名不合法" })

          ;(async () => {
            const bak = backupBeforeWrite({ profileName: "desktop" })
            if (!bak.ok) return json(res, 500, { error: "备份失败，为安全起见不写" })

            try {
              const api = await loadMarketPatchApi()
              const patchFile = locatePatchFile(null)
              const r = await setPluginEnabled({
                patchFile,
                rowId: pluginId,
                api: api && api.mod,
                disable,
              })
              if (!r.ok) {
                return json(res, 500, { error: r.reason || "写入失败", via: r.via, backups: bak.made })
              }

              const st = readToggleState({ patchFile, rowId: pluginId, api: api && api.mod })
              const expected = disable
              if (st.known && Boolean(st.disabled) !== expected) {
                return json(res, 500, {
                  error: "写入后回读状态不一致，请手动检查：" + (st.disabled ? "仍是停用" : "仍是启用"),
                  via: r.via,
                  backups: bak.made,
                })
              }

              invalidateApiCache()
              json(res, 200, {
                status: "written",
                pluginId,
                disabled: Boolean(st.disabled),
                via: r.via,
                backups: bak.made,
                note: "不用重启。刷新页面（或点刷新按钮）后生效。回滚：node rescue.mjs restore <备份名>",
              })
            } catch (error) {
              json(res, 500, { error: String((error && error.message) || error).slice(0, 200), backups: bak.made })
            }
          })()
        })
        req.on("error", () => json(res, 400, { error: "读取请求失败" }))
      },
    })
    if (typeof ctx?.effect === "function" && typeof dispose === "function") {
      try { ctx.effect(() => dispose) } catch {   }
    }
    results["toggle-plugin"] = true
  } catch (error) {
    try { console.error("[dsh-atlas] 启停路由注册失败：" + String((error && error.message) || error)) } catch {   }
    results["toggle-plugin"] = false
  }

  const ok = Object.keys(results).some((k) => results[k])
  return ok
    ? { ok: true, routes: results }
    : { ok: false, reason: "4 条路由全部注册失败：" + JSON.stringify(results) }
}

export { ROUTE_PREFIX, VERSION }
