
const DEPENDENCY_NAME_RE = /(?:^|[-/])(?:kit|runtime|shared|common|utils?|core|types|sdk)(?:$|[-.])/i

const DEPENDENCY_DESC_RE = /(共用工具包|公共工具包|工具包[：:]|shared\s+(?:kit|utils?|runtime)|plugin\s+kit|helper\s+library|for\s+other\s+plugins)/i

import { aggregateOf } from './aggregates.js'

function looksLikeDependency(p, allIds) {
  if (!p || !p.id) return false
  if (p.inBundles) return false
  if (p.hasDshField && p.patchIds && p.patchIds.length > 0) return false

  const pref = familyPrefix(p.id)
  if (pref !== p.id) {
    const hasSibling = (allIds || []).some((id) => id !== p.id && id.startsWith(pref))
    if (hasSibling) return false
  }

  const byName = DEPENDENCY_NAME_RE.test(p.id)
  const byDesc = DEPENDENCY_DESC_RE.test(String(p.description || ""))
  return byName || byDesc
}

function familyPrefix(id) {
  if (typeof id !== "string" || !id) return id
  const scopeMatch = /^(@[^/]+)\/(.+)$/.exec(id)
  const scope = scopeMatch ? scopeMatch[1] : ""
  const bare = scopeMatch ? scopeMatch[2] : id

  const parts = bare.split("-")
  if (parts.length < 3) return scope ? scope + "/" + bare : bare
  const prefix = parts.slice(0, -1).join("-") + "-"
  return scope ? scope + "/" + prefix : prefix
}

export function groupFamilies(plugins) {
  const warnings = []
  const list = Array.isArray(plugins) ? plugins.filter((p) => p && p.id) : []
  if (!list.length) return { families: [], warnings: ["没有插件可归组"] }

  const byKey = new Map()
  const keyOf = new Map()

  const dependencies = []
  const realPlugins = []
  const allIds = list.map((p) => p.id)
  for (const p of list) {
    if (looksLikeDependency(p, allIds)) dependencies.push(p)
    else realPlugins.push(p)
  }

  for (const p of realPlugins) {
    if (!p.repo || !p.repo.owner || !p.repo.repo) continue
    keyOf.set(p.id, "repo:" + p.repo.owner + "/" + p.repo.repo)
  }

  const scopeCount = new Map()
  for (const p of realPlugins) {
    if (keyOf.has(p.id)) continue
    const m = /^(@[^/]+)\//.exec(p.id)
    if (!m) continue
    scopeCount.set(m[1], (scopeCount.get(m[1]) || 0) + 1)
  }
  for (const p of realPlugins) {
    if (keyOf.has(p.id)) continue
    const m = /^(@[^/]+)\//.exec(p.id)
    if (!m) continue
    if ((scopeCount.get(m[1]) || 0) < 2) continue
    keyOf.set(p.id, "scope:" + m[1])
  }

  for (const p of realPlugins) {
    if (keyOf.has(p.id)) continue
    const pref = familyPrefix(p.id)
    const k = pref === p.id ? "solo:" + p.id : "prefix:" + pref
    keyOf.set(p.id, k)
  }

  for (const p of realPlugins) {
    const k = keyOf.get(p.id)
    if (!byKey.has(k)) {
      byKey.set(k, {
        key: k,
        members: [],
        repo: p.repo ? p.repo.owner + "/" + p.repo.repo : null,
        repoUrl: p.repoUrl || null,
      })
    }
    byKey.get(k).members.push(p)
  }

  const families = []
  for (const fam of byKey.values()) {
    const members = fam.members
    const sorted = members.slice().sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id))
    const head = sorted[0]

    let displayName = head.id
    if (members.length > 1) {
      const pref = familyPrefix(head.id)
      const coveredByPrefix = members.every((m) => m.id === head.id || m.id.startsWith(pref))
      if (!coveredByPrefix) {
        displayName = fam.repo ? fam.repo.split("/")[1] : head.id.split("/")[0] + "/*"
      }
    }

    const versions = [...new Set(members.map((m) => m.version).filter(Boolean))]
    const version = head.version || (versions.length === 1 ? versions[0] : null)

    const inBundles = members.some((m) => m.inBundles)
    const enabledMembers = members.filter((m) => m.inBundles).map((m) => m.id)

    const tools = []
    const toolSet = new Set()
    for (const m of members) {
      for (const t of m.tools || []) {
        if (toolSet.has(t)) continue
        toolSet.add(t)
        tools.push(t)
      }
    }

    const patchIds = []
    for (const m of members) {
      for (const pid of m.patchIds || []) if (patchIds.indexOf(pid) < 0) patchIds.push(pid)
    }

    const modified = []
    for (const m of members) {
      for (const f of (m.modified && m.modified.files) || []) modified.push(m.id + "/" + f)
    }

    const sourceTypes = [...new Set(members.map((m) => m.sourceType).filter(Boolean))]

    const agg = fam.repo ? aggregateOf(fam.repo) : null
    const aggregateRole = agg
      ? (agg.aggregate === fam.repo ? 'aggregate' : 'satellite')
      : null
    const nestedUnder = aggregateRole === 'satellite' ? agg.aggregate : null

    families.push({
      key: fam.key,
      name: displayName,
      aggregateRole,
      nestedUnder,
      aggregateNote: agg
        ? (agg.aggregate === fam.repo
            ? `聚合仓库，用子模块锁定 ${agg.satellites.length} 个下游仓库`
            : `被 ${agg.aggregate} 当子模块聚合，要等它 bump 指针才会一起发布`)
        : null,
      headId: head.id,
      repo: fam.repo,
      repoUrl: fam.repoUrl,
      version,
      versionConflict: versions.length > 1,
      versions,
      packageCount: members.length,
      inBundles,
      enabledMembers,
      sourceTypes,
      isSelf: members.some((m) => m.isSelf),
      tools,
      patchIds,
      modified,
      members: sorted.map((m) => ({
        id: m.id,
        version: m.version,
        sourceType: m.sourceType,
        inBundles: m.inBundles,
        description: m.description || "",
        tools: m.tools || [],
        patchIds: m.patchIds || [],
        modified: (m.modified && m.modified.files) || [],
      })),
    })
  }

  families.sort((a, b) => {
    if (a.inBundles !== b.inBundles) return a.inBundles ? -1 : 1
    if (a.packageCount !== b.packageCount) return b.packageCount - a.packageCount
    return a.name.localeCompare(b.name)
  })

  const byRepo = new Map()
  for (const f of families) {
    if (f.repo) byRepo.set(f.repo, f)
  }
  const absorbed = new Set()
  for (const f of families) {
    if (!f.nestedUnder) continue
    const parent = byRepo.get(f.nestedUnder)
    if (!parent) continue
    if (!parent.children) parent.children = []
    parent.children.push(f)
    absorbed.add(f.key)
  }
  const flatFamilies = families.filter((f) => !absorbed.has(f.key))
  for (const f of flatFamilies) {
    if (!f.children || !f.children.length) continue
    f.childPackageCount = f.children.reduce((n, c) => n + c.packageCount, 0)
    f.childToolCount = f.children.reduce((n, c) => n + c.tools.length, 0)
  }

  return {
    families: flatFamilies,
    dependencies: dependencies.map((p) => ({
      id: p.id,
      version: p.version,
      sourceType: p.sourceType,
      description: p.description || "",
      inBundles: p.inBundles,
    })),
    warnings,
  }
}

export function summarizeFamilies(families, dependencies) {
  const list = Array.isArray(families) ? families : []
  const deps = Array.isArray(dependencies) ? dependencies : []
  return {
    families: list.length,
    packages: list.reduce((n, f) => n + f.packageCount, 0),
    dependencies: deps.length,
    enabled: list.filter((f) => f.inBundles).length,
    withTools: list.filter((f) => f.tools.length > 0).length,
    withPatches: list.filter((f) => f.patchIds.length > 0).length,
    withModifications: list.filter((f) => f.modified.length > 0).length,
  }
}
