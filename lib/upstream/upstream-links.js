import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const CATALOG_FILENAME = "community.json"

function findCatalogFile(nodeModulesDir) {
  if (!nodeModulesDir || !existsSync(nodeModulesDir)) return null
  const tryDir = (d, depth) => {
    if (depth > 3) return null
    let ents
    try { ents = readdirSync(d, { withFileTypes: true }) } catch { return null }
    for (const e of ents) {
      if (e.isFile && e.name === CATALOG_FILENAME) return join(d, e.name)
    }
    for (const e of ents) {
      if (e.name === ".bin" || e.name === ".cache") continue
      const sub = join(d, e.name)
      if (!existsSync(sub)) continue
      const found = tryDir(sub, depth + 1)
      if (found) return found
    }
    return null
  }
  return tryDir(nodeModulesDir, 0)
}

export function loadCatalog(nodeModulesDir) {
  if (!nodeModulesDir) return { entries: [], source: null }
  const file = findCatalogFile(nodeModulesDir)
  if (!file) return { entries: [], source: null }
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    const entries = Array.isArray(data) ? data : []
    return { entries, source: file }
  } catch {
    return { entries: [], source: null }
  }
}

export function matchCatalog(catalog, pluginId, bareName) {
  if (!Array.isArray(catalog) || !catalog.length) return null
  const id = String(pluginId || '').toLowerCase()
  const bare = String(bareName || '').toLowerCase()
  for (const c of catalog) {
    if (c.npm && String(c.npm).toLowerCase() === id) return c
  }
  for (const c of catalog) {
    if (c.id && String(c.id).toLowerCase() === bare) return c
    if (c.npm && String(c.npm).toLowerCase() === bare) return c
  }
  return null
}

export function bareName(id) {
  return String(id || '').replace(/^@[^/]+\//, '')
}

export function resolveUpstream(plugin, catalog) {
  const bare = bareName(plugin.id)

  if (plugin.repoUrl) {
    return {
      url: normalizeGithubUrl(plugin.repoUrl),
      source: 'package.json',
      verified: true,
      note: '作者在 package.json 里写的',
    }
  }
  if (plugin.repo && plugin.repo.owner && plugin.repo.repo) {
    return {
      url: `https://github.com/${plugin.repo.owner}/${plugin.repo.repo}`,
      source: 'package.json',
      verified: true,
      note: '作者在 package.json 里写的',
    }
  }

  const hit = matchCatalog(catalog, plugin.id, bare)
  if (hit && hit.repo) {
    return {
      url: normalizeGithubUrl(hit.repo),
      source: '插件市场目录',
      verified: true,
      note: `市场目录里的条目（作者 ${hit.author || '未知'}）`,
    }
  }

  if (plugin.sourceType === 'link-junction' || plugin.sourceType === 'link-source') {
    return {
      url: null,
      source: '本地安装',
      verified: false,
      note: 'link 安装（本地源码），没有发布到 npm，因此没有上游仓库链接',
    }
  }

  if (plugin.repoSiblings && plugin.repoSiblings.length) {
    const counts = new Map()
    for (const url of plugin.repoSiblings) {
      const k = normalizeGithubUrl(url)
      if (k) counts.set(k, (counts.get(k) || 0) + 1)
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
    const total = plugin.repoSiblings.length
    if (sorted.length && sorted[0][1] >= 3 && sorted[0][1] / total >= 0.6) {
      return {
        url: sorted[0][0],
        source: '同 scope 推断',
        verified: false,
        note: `这个包自己的 package.json 没写 repository，但同 scope 有 ${sorted[0][1]} 个包指向这里（推断，不是官方声明）`,
      }
    }
  }

  return {
    url: null,
    source: '未找到',
    verified: false,
    note: '作者没有在 package.json 写 repository，插件市场目录里也没收录，同 scope 也没有足够的一致证据',
  }
}

export function normalizeGithubUrl(raw) {
  let s = String(raw || '').trim()
  if (!s) return null
  s = s.replace(/^git\+/, '')
  s = s.replace(/^git:\/\//, 'https://')
  s = s.replace(/\.git$/, '')
  s = s.replace(/^ssh:\/\/git@github\.com[:/]/, 'https://github.com/')
  s = s.replace(/^git@github\.com:/, 'https://github.com/')
  return s
}

export function enrichUpstream(plugins, nodeModulesDir) {
  const { entries, source } = loadCatalog(nodeModulesDir)
  const list = Array.isArray(plugins) ? plugins : []

  const scopeRepos = new Map()
  for (const p of list) {
    const m = /^(@[^/]+)\//.exec(p.id)
    if (!m || !p.repoUrl) continue
    if (!scopeRepos.has(m[1])) scopeRepos.set(m[1], [])
    scopeRepos.get(m[1]).push(p.repoUrl)
  }

  const out = list.map((p) => {
    const m = /^(@[^/]+)\//.exec(p.id)
    const repoUrl = p.repoUrl ? null : p.repoUrl
    const siblings = m && !p.repoUrl ? (scopeRepos.get(m[1]) || []) : []
    return {
      id: p.id,
      upstream: resolveUpstream({ ...p, repoSiblings: siblings }, entries),
    }
  })
  const stats = {
    total: out.length,
    withUrl: out.filter((x) => x.upstream.url).length,
    fromPackageJson: out.filter((x) => x.upstream.source === 'package.json').length,
    fromCatalog: out.filter((x) => x.upstream.source === '插件市场目录').length,
    localOnly: out.filter((x) => x.upstream.source === '本地安装').length,
    missing: out.filter((x) => x.upstream.source === '未找到').length,
    catalogSize: entries.length,
    catalogSource: source,
  }
  return { byId: new Map(out.map((x) => [x.id, x.upstream])), stats }
}
