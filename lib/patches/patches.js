import { readFileSync, writeFileSync, existsSync, statSync, copyFileSync, mkdirSync, readdirSync, unlinkSync, realpathSync } from 'node:fs'
import { join, dirname, basename, relative, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { atlasRoot, dshHome, profileNodeModules } from '../core/paths.js'

export function patchesDir(root = atlasRoot()) {
  return join(root, 'patches')
}

export function patchSearchDirs(root = atlasRoot()) {
  const here = dirname(fileURLToPath(import.meta.url))
  const pkgRoot = join(here, '..', '..')
  const pkgPatches = join(pkgRoot, 'patches')
  return [patchesDir(root), pkgPatches]
}

export function snapshotsDir(root = atlasRoot()) {
  return join(root, 'snapshots')
}

export function resolveTarget(spec) {
  if (!spec) throw new Error('补丁缺少 target')
  if (isAbsolute(spec) || /^[A-Za-z]:[\\/]/.test(spec)) return spec
  const idx = spec.indexOf(':')
  if (idx === -1) throw new Error(`无法识别的 target 格式：${spec}`)
  const kind = spec.slice(0, idx)
  const rest = spec.slice(idx + 1)
  const toAbs = (base) => join(base, rest.replace(/\//g, '\\'))

  if (kind === 'profile') {
    return toAbs(profileNodeModules())
  }
  if (kind === 'surfcore') {
    const base = process.env.DSH_SURFCORE_ROOT || surfcoreRepoRoot()
    return toAbs(base)
  }
  if (kind === 'surfcore-plugin') {
    const base = process.env.DSH_SURFCORE_PLUGIN_ROOT
      || join(dshHome(), 'plugins', 'surfcore')
    return toAbs(base)
  }
  if (kind === 'snowluma') {
    const base = process.env.SNOWLUMA_HOME
      || join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'SnowLuma')
    return toAbs(base)
  }
  if (kind === 'home') {
    return join(dshHome(), rest)
  }
  throw new Error(`未知的 target 前缀：${kind}`)
}

export function surfcoreRepoRoot() {
  const link = join(dshHome(), 'plugins', 'surfcore')
  try {
    const real = realpathSync(link)
    const parent = dirname(real)
    return basename(parent) === 'plugins' ? dirname(parent) : real
  } catch {
    return link
  }
}

export function fileHash(file) {
  if (!existsSync(file)) return null
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

export function hardlinkCount(file) {
  if (process.platform !== 'win32') return -1
  try {
    const out = execFileSync(`fsutil hardlink list "${file}"`, {
      encoding: 'utf8',
      shell: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    return lines.length || -1
  } catch {
    return -1
  }
}

export function checkPatch(patch) {
  let target
  try {
    target = resolveTarget(patch.target)
  } catch (error) {
    return { status: 'target-invalid', detail: String(error.message), target: patch.target }
  }

  if (!existsSync(target)) {
    return { status: 'file-missing', detail: `目标文件不存在：${target}`, target }
  }

  const content = readFileSync(target, 'utf8')

  if (patch.marker) {
    const re = new RegExp(patch.marker, 'm')
    if (re.test(content)) {
      return { status: 'applied', detail: '找到补丁标记', target }
    }
  } else if (patch.expect) {
    const re = new RegExp(patch.expect, 'm')
    if (re.test(content)) return { status: 'applied', detail: '符合预期形态', target }
  }

  const anchorFound = patch.anchor ? new RegExp(patch.anchor, 'm').test(content) : false
  if (!anchorFound) {
    return {
      status: 'anchor-missing',
      detail: patch.anchor
        ? `补丁不在，且锚点也找不到（上游可能改结构了）：${patch.anchor}`
        : '补丁不在，且没有定义 anchor',
      target,
    }
  }

  return { status: 'missing', detail: '补丁不在，但锚点还在 —— 可以安全重放', target }
}

export function applyPatch(patch, options = {}) {
  const target = resolveTarget(patch.target)

  if (!existsSync(target)) {
    return { ok: false, action: 'skipped', detail: `目标文件不存在：${target}` }
  }

  let content = readFileSync(target, 'utf8')

  if (patch.marker && new RegExp(patch.marker, 'm').test(content)) {
    return { ok: true, action: 'noop', detail: '补丁已存在，未做改动' }
  }

  if (!patch.anchor) {
    return { ok: false, action: 'refused', detail: '补丁没有定义 anchor，拒绝盲改' }
  }

  const anchorRe = new RegExp(patch.anchor, 'm')
  const match = anchorRe.exec(content)
  if (!match) {
    return { ok: false, action: 'onMiss', detail: `锚点未命中，拒绝猜测插入位置：${patch.anchor}` }
  }

  let updated
  if (patch.replace !== undefined) {
    const replaced = match[0].replace(anchorRe, patch.replace)
    updated = content.slice(0, match.index) + replaced + content.slice(match.index + match[0].length)
  } else if (patch.insertAfter !== undefined) {
    updated = content.slice(0, match.index + match[0].length)
      + patch.insertAfter
      + content.slice(match.index + match[0].length)
  } else if (patch.insertBefore !== undefined) {
    updated = content.slice(0, match.index) + patch.insertBefore + content.slice(match.index)
  } else {
    return { ok: false, action: 'refused', detail: '补丁既没有 replace 也没有 insertAfter/insertBefore' }
  }

  if (options.dryRun) {
    return { ok: true, action: 'would-apply', detail: `试运行：将改动 ${target}` }
  }

  const links = hardlinkCount(target)
  if (links > 1) {
    const backup = `${target}.bak-atlas-${Date.now()}`
    copyFileSync(target, backup)
    unlinkSync(target)
    writeFileSync(target, updated, 'utf8')
    return {
      ok: true,
      action: 'applied-unlinked',
      detail: `原为 ${links} 个硬链接，已断链后写入`,
      backup,
    }
  }

  const backup = `${target}.bak-atlas-${Date.now()}`
  copyFileSync(target, backup)
  writeFileSync(target, updated, 'utf8')
  return { ok: true, action: 'applied', detail: '已写入（已备份）', backup }
}

export function loadPatches(root = atlasRoot()) {
  const byId = new Map()
  for (const dir of patchSearchDirs(root)) {
    if (!existsSync(dir)) continue
    let names
    try { names = readdirSync(dir) } catch { continue }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const full = join(dir, name)
      try {
        const data = JSON.parse(readFileSync(full, 'utf8'))
        const list = Array.isArray(data) ? data : [data]
        for (const p of list) {
          if (!p || !p.id) continue
          byId.set(p.id, { ...p, _file: full })
        }
      } catch (error) {
        byId.set(`__broken__${name}`, {
          id: `__broken__${name}`,
          _file: full,
          _broken: String(error.message),
          target: null,
        })
      }
    }
  }
  return [...byId.values()]
}

export function checkAllPatches(root = atlasRoot()) {
  const patches = loadPatches(root)
  const results = patches.map((p) => {
    if (p._broken) return { patch: p, status: 'definition-broken', detail: p._broken, target: p.target }
    return { patch: p, ...checkPatch(p) }
  })

  const summary = {
    total: results.length,
    applied: results.filter((r) => r.status === 'applied').length,
    missing: results.filter((r) => r.status === 'missing').length,
    anchorMissing: results.filter((r) => r.status === 'anchor-missing').length,
    fileMissing: results.filter((r) => r.status === 'file-missing').length,
    broken: results.filter((r) => r.status === 'definition-broken' || r.status === 'target-invalid').length,
  }
  return { summary, results }
}
