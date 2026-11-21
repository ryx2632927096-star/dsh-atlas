import { readdirSync, lstatSync, readFileSync, realpathSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHome, currentProfile } from '../core/paths.js'
import { parseRepo } from '../upstream/upstream.js'

const SELF_DIR = fileURLToPath(new URL('../../', import.meta.url))

const DSH_NAME_RE = /(^|\/)dsh[-_]/

const LOOSE_NAME_RE = /dsh|surfcore/i

const DEFAULT_PROFILE = () => currentProfile()

function samePath(a, b) {
  if (!a || !b) return false
  const norm = (p) => String(p).toLowerCase().replace(/[\\/]+$/, '')
  return norm(a) === norm(b)
}

function prefixLen(prefix, target) {
  if (!prefix || !target) return -1
  const p = prefix.toLowerCase().replace(/[\\/]+$/, '')
  const t = target.toLowerCase()
  if (!t.startsWith(p)) return -1
  if (t.length === p.length) return p.length
  const sep = t.charAt(p.length)
  return sep === '\\' || sep === '/' ? p.length : -1
}

function readJson(file, warnings, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (warnings && existsSync(file)) {
      warnings.push(`${label}：${file} 解析失败（${String(error.message).slice(0, 120)}）`)
    }
    return null
  }
}

function safeLstat(path) {
  try { return lstatSync(path) } catch { return null }
}

function classifyEntry(path) {
  const st = safeLstat(path)
  if (!st) return { ok: false, isLink: false }
  if (st.isSymbolicLink()) return { ok: true, isLink: true }
  if (st.isDirectory()) return { ok: true, isLink: false }
  return { ok: false, isLink: false }
}

function listPackageDirs(nodeModules, warnings) {
  const out = []
  let entries
  try { entries = readdirSync(nodeModules) } catch (error) {
    warnings.push(`node_modules 读不到（${nodeModules}）：${String(error.message).slice(0, 120)}`)
    return out
  }

  for (const name of entries) {
    if (!name || name.startsWith('.')) continue
    const full = join(nodeModules, name)
    const cls = classifyEntry(full)
    if (!cls.ok) continue

    if (name.startsWith('@')) {
      let scopeDir = full
      try { scopeDir = realpathSync(full) } catch {   }
      let subs
      try { subs = readdirSync(scopeDir) } catch (error) {
        warnings.push(`scope 目录读不到（${full}）：${String(error.message).slice(0, 120)}`)
        continue
      }
      for (const sub of subs) {
        const subPath = join(full, sub)
        const subCls = classifyEntry(subPath)
        if (!subCls.ok) continue
        out.push({ id: `${name}/${sub}`, installedDir: subPath, isLink: subCls.isLink })
      }
      continue
    }

    out.push({ id: name, installedDir: full, isLink: cls.isLink })
  }
  return out
}

function readPatchEntries(profileDir, warnings) {
  const file = join(profileDir, 'cordis.patch.yml')
  let text
  try { text = readFileSync(file, 'utf8') } catch { return [] }

  const out = []
  let current = null
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    const idMatch = /^\s*-\s+id:\s*(.+?)\s*$/.exec(line)
    if (idMatch) {
      if (current) out.push(current)
      current = { id: idMatch[1].replace(/^['"]|['"]$/g, ''), name: null }
      continue
    }
    if (!current) continue
    const nameMatch = /^\s+name:\s*(.+?)\s*$/.exec(line)
    if (nameMatch && current.name === null) {
      current.name = nameMatch[1].replace(/^['"]|['"]$/g, '')
    }
  }
  if (current) out.push(current)
  if (!out.length) warnings.push(`cordis.patch.yml 里没解析到任何 "- id:" 条目（${file}）`)
  return out
}

export function discoverPlugins(options = {}) {
  const warnings = []
  const home = options.home || dshHome()
  const profileName = options.profileName || DEFAULT_PROFILE()
  const profileDir = join(home, 'profiles', profileName)
  const nodeModules = join(profileDir, 'node_modules')

  const plugins = []
  if (!existsSync(nodeModules)) {
    warnings.push(`找不到 node_modules：${nodeModules}`)
    return { plugins, warnings }
  }

  const profilePkg = readJson(join(profileDir, 'package.json'), warnings, 'profile package.json') || {}
  const dependencies = profilePkg.dependencies && typeof profilePkg.dependencies === 'object' ? profilePkg.dependencies : {}
  const bundlesRaw = profilePkg?.dsh?.profile?.bundles
  const bundles = Array.isArray(bundlesRaw) ? bundlesRaw : []
  if (!Array.isArray(bundlesRaw)) warnings.push('profile package.json 里没有 dsh.profile.bundles（inBundles 全部为 false）')

  const patchEntries = readPatchEntries(profileDir, warnings)

  for (const entry of listPackageDirs(nodeModules, warnings)) {
    let pkg = readJson(join(entry.installedDir, 'package.json'), null, 'package.json')
    if (!pkg) {
      warnings.push(`包缺 package.json 或读不到：${entry.installedDir}`)
      continue
    }
    const id = typeof pkg.name === 'string' && pkg.name ? pkg.name : entry.id

    const hasDshField = !!(pkg.dsh && typeof pkg.dsh === 'object' && Object.keys(pkg.dsh).length)
    if (!hasDshField && !DSH_NAME_RE.test(id) && !LOOSE_NAME_RE.test(id)) continue

    let realDir
    try { realDir = realpathSync(entry.installedDir) } catch (error) {
      warnings.push(`realpath 失败（${entry.installedDir}）：${String(error.message).slice(0, 120)}`)
      realDir = entry.installedDir
    }

    const depSpec = typeof dependencies[id] === 'string' ? dependencies[id] : null
    const isLinkSpec = typeof depSpec === 'string' && depSpec.startsWith('link:')
    let sourceType = 'npm'
    if (entry.isLink) {
      const isJunction = process.platform === 'win32'
      sourceType = isJunction ? 'link-junction' : 'link-source'
      if (!isLinkSpec) {
        warnings.push(`${id} 的目录是链接，但 profile dependencies 里没有 link: 声明（${depSpec ?? '缺失'}）`)
      }
    } else if (isLinkSpec) {
      warnings.push(`${id} 在 dependencies 里声明为 link:，但目录不是链接（可能是硬拷贝安装）`)
    }

    const repoRaw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || null
    const repo = repoRaw ? parseRepo(repoRaw) : null
    const gitHead = pkg.gitHead || pkg._gitHead || pkg.git?.head || null

    const bundleOrderRaw = bundles.indexOf(id)
    const patchIds = patchEntries
      .filter((p) => p.name === id || p.id === id)
      .map((p) => p.id)

    plugins.push({
      id,
      version: typeof pkg.version === 'string' ? pkg.version : null,
      sourceType,
      installedDir: entry.installedDir,
      realDir,
      repo: repo ? { owner: repo.owner, repo: repo.repo } : null,
      repoUrl: repoRaw,
      gitHead,
      inDependencies: Object.prototype.hasOwnProperty.call(dependencies, id),
      inBundles: bundleOrderRaw !== -1,
      bundleOrder: bundleOrderRaw === -1 ? null : bundleOrderRaw,
      patchIds,
      hasDshField,
      isSelf: samePath(realDir, SELF_DIR),
      description: typeof pkg.description === 'string' ? pkg.description.slice(0, 200) : '',
    })
  }

  plugins.sort((a, b) => a.id.localeCompare(b.id))

  if (!plugins.some((p) => p.isSelf)) {
    warnings.push(`本插件自身（${SELF_DIR}）不在发现结果里 —— 通常是 Junction 未生效或未安装`)
  }

  return { plugins, warnings }
}

export function pluginForPath(absPath, plugins) {
  if (!absPath || !Array.isArray(plugins) || !plugins.length) return null
  const target = String(absPath)
  let best = null
  let bestLen = -1
  for (const plugin of plugins) {
    for (const base of [plugin.realDir, plugin.installedDir]) {
      const len = prefixLen(base, target)
      if (len > bestLen) { bestLen = len; best = plugin }
    }
  }
  return best
}

export function summarizeBySource(plugins) {
  const counts = { npm: 0, 'link-junction': 0, 'link-source': 0 }
  for (const p of plugins) counts[p.sourceType] = (counts[p.sourceType] || 0) + 1
  return counts
}
