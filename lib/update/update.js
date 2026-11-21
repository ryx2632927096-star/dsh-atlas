import { readFileSync, writeFileSync, mkdirSync, lstatSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dshHome, atlasRoot, profileDir, currentProfile } from '../core/paths.js'
import { plainPath, present, contained } from '../core/safe-tree.js'
import { runDshCli, findDshCli } from '../core/dsh-cli.js'
import { checkAllPatches } from '../patches/patches.js'
import { makeSnapshot, readSnapshot, restoreSnapshot, sameProfile, linkPolicy, captureProfile } from './profile-transaction.js'

const validName = (name) => typeof name === 'string' && name.length <= 214
  && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) && name !== 'node_modules'
function validProfile(profile) {
  if (typeof profile !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(profile)) throw new Error('profile名不合法')
  return profile
}
function context(options = {}) {
  const profile = validProfile(options.profile || currentProfile())
  const dir = plainPath(options.profile ? contained(join(dshHome(), 'profiles'), join(dshHome(), 'profiles', profile)) : profileDir())
  return { profile, dir, nm: plainPath(join(dir, 'node_modules')) }
}
function validateNames(names, allowed) {
  if (!Array.isArray(names) || names.length === 0) throw new Error('没有指定要更新的包')
  if (names.some((n) => !validName(n))) throw new Error('包名不合法，拒绝路径/选项注入')
  if (new Set(names).size !== names.length) throw new Error('包名重复，未执行')
  if (allowed && names.some((n) => !allowed.has(n))) throw new Error('只接受当前依赖清单中合法且可更新的npm包，拒绝未知/link/git来源')
}
export function isUpdatableSpec(spec) {
  if (typeof spec !== 'string' || !spec.trim()) return false
  const s = spec.trim()
  if (/^[a-z][a-z0-9._-]*$/i.test(s)) return true
  const version = /^(?:[<>=~^]{0,2})v?(?:\d+|[xX*])(?:\.(?:\d+|[xX*])){0,2}(?:-[a-z0-9.-]+)?(?:\+[a-z0-9.-]+)?$/i
  return s.split(/\s*\|\|\s*/).every((part) => part.trim().replace(/\s+-\s+/g, ' ').split(/\s+/).every((token) => version.test(token)))
}
export function loadDependencies(options = {}) {
  try {
    const { profile, dir } = context(options)
    const file = plainPath(join(dir, 'package.json'))
    const pkg = JSON.parse(readFileSync(file, 'utf8'))
    const dependencies = pkg.dependencies || {}
    if (typeof dependencies !== 'object' || Array.isArray(dependencies)) throw new Error('dependencies不是对象')
    const updatable = [], linked = []
    for (const [name, spec] of Object.entries(dependencies)) {
      const item = { name, spec }
      ;(validName(name) && isUpdatableSpec(spec) ? updatable : linked).push(item)
    }
    return { ok: true, profile, profileDir: dir, updatable, linked, dependencies }
  } catch (error) { return { ok: false, error: error.message } }
}
export function installedVersion(name, options = {}) {
  if (!validName(name)) return null
  try {
    const { nm } = context(options)
    const file = plainPath(contained(nm, join(nm, name, 'package.json')))
    const pkg = JSON.parse(readFileSync(file, 'utf8'))
    return pkg.name === name && typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version : null
  } catch { return null }
}
function preflight(names, options) {
  validateNames(names)
  const deps = loadDependencies(options)
  if (!deps.ok) throw new Error(deps.error)
  validateNames(names, new Set(deps.updatable.map((d) => d.name)))
  const { nm } = context(options)
  for (const name of names) {
    const path = plainPath(contained(nm, join(nm, name)))
    if (!lstatSync(path).isDirectory() || !installedVersion(name, options)) throw new Error('已装包不是完整普通目录：' + name)
  }
  return deps
}
function backupBase() { return plainPath(join(atlasRoot(), 'backups')) }
function backupPath(path) { return plainPath(contained(backupBase(), path)) }
export function updateBackupRoot(stamp = randomUUID()) {
  if (!/^[a-zA-Z0-9-]+$/.test(stamp)) throw new Error('备份标识不合法')
  return join(backupBase(), 'update-' + stamp)
}
export function backupPlugins(names, root = updateBackupRoot(), options = {}) {
  try {
    const deps = preflight(names, options)
    const dir = backupPath(root)
    const saved = makeSnapshot(deps.profileDir, dir, names, deps.dependencies, options)
    return { ok: true, dir, copied: names, before: saved.before }
  } catch (error) { return { ok: false, failed: [error.message], error: error.message } }
}
export function restorePlugins(root, names, options = {}) {
  try {
    validateNames(names)
    const dir = context(options).dir, savedRoot = backupPath(root)
    readSnapshot(savedRoot, dir, names)
    const pkg = JSON.parse(readFileSync(join(savedRoot, 'files', 'package.json'), 'utf8'))
    validateNames(names, new Set(Object.entries(pkg.dependencies || {}).filter(([n,s]) => validName(n) && isUpdatableSpec(s)).map(([n]) => n)))
    return restoreSnapshot(savedRoot, dir, names)
  } catch (error) { return { ok: false, verified: false, failed: [error.message] } }
}
export async function runDshPluginAdd(names, options = {}) {
  try {
    const deps = preflight(names, options)
    const root = backupPath(options.backupDir)
    const saved = readSnapshot(root, deps.profileDir, names)
    sameProfile(deps.profileDir, saved.before, linkPolicy(deps.profileDir, deps.dependencies))
    const cli = options.cli || findDshCli()
    if (!cli) throw new Error('找不到DSH CLI')
    const args = ['plugin', '--profile', deps.profile, 'add', ...names.map((n) => n + '@latest'),
      '--ignore-scripts', '--ignore-pnpmfile', '--ignore-workspace']
    const r = await runDshCli(args, { cli, cwd: deps.profileDir, timeoutMs: options.timeoutMs,
      env: { ...process.env, ...options.env, DSH_PROFILE: deps.profile, DSH_PROFILE_DIR: deps.profileDir,
        npm_config_ignore_scripts: 'true', npm_config_ignore_pnpmfile: 'true' } })
    return { ok: r.status === 0 && !r.error, status: r.status, quiescent: r.quiescent,
      output: ((r.stdout || '') + (r.stderr || '')).slice(-4000), args: args.join(' '),
      error: r.error?.message || (r.status !== 0 ? '包管理器退出码：' + r.status : undefined) }
  } catch (error) { return { ok: false, quiescent: true, error: error.message } }
}

export async function updatePlugins(names, options = {}) {
  let deps
  try { deps = preflight(names, options) }
  catch (error) { return { ok: false, phase: 'validate', error: error.message } }
  const before = Object.fromEntries(names.map((n) => [n, installedVersion(n, options)]))
  if (options.dryRun !== false) return { ok: true, dryRun: true,
    wouldUpdate: names.map((name) => ({ name, from: before[name], to: 'latest' })),
    command: 'dsh plugin --profile ' + deps.profile + ' add ' + names.map((n) => n + '@latest').join(' ') }
  let lock
  try { lock = plainPath(join(deps.profileDir, '.atlas-update.lock')) }
  catch (error) { return { ok: false, phase: 'lock', error: error.message } }
  const token = randomUUID()
  let ownsLock = false, canUnlock = true, bk
  try {
    writeFileSync(lock, token, { flag: 'wx' }); ownsLock = true
    bk = backupPlugins(names, updateBackupRoot(), options)
    if (!bk.ok) return { ok: false, phase: 'backup', error: bk.error, backup: bk }
    const result = await runDshPluginAdd(names, { ...options, backupDir: bk.dir })
    const after = Object.fromEntries(names.map((n) => [n, installedVersion(n, options)]))
    let problem = result.ok && names.some((n) => !after[n]) ? '更新后包名/版本或目录类型校验失败' : ''
    const savedLinks = bk.before.installation.entries.filter((e) => e.kind === 'link')
    if (result.ok) {
      try {
        const next = loadDependencies(options)
        if (!next.ok) throw new Error('更新后profile声明不可解析')
        for (const linked of deps.linked) if (next.dependencies[linked.name] !== linked.spec) throw new Error('非npm依赖声明发生改变')
        const current = captureInstallation(deps.profileDir, deps.dependencies)
        for (const link of savedLinks) if (!current.entries.some((e) => JSON.stringify(e) === JSON.stringify(link))) throw new Error('已保护的链接发生改变')
      } catch (error) { problem = error.message }
    }
    if (!result.ok || problem) {
      if (result.quiescent === false) {
        canUnlock = false
        return { ok: false, phase: 'stop', error: '不能确认更新子进程已停止，未冒险回滚；保留事务锁和备份，请人工确认', backupDir: bk.dir, versions: { before, after } }
      }
      const rolledBack = restorePlugins(bk.dir, names, options)
      const post = Object.fromEntries(names.map((n) => [n, installedVersion(n, options)]))
      if (rolledBack.ok) {
        try {
          sameProfile(deps.profileDir, bk.before, () => true)
          if (names.some((n) => before[n] !== post[n])) throw new Error('恢复后的版本与前态不一致')
        } catch (error) { rolledBack.ok = false; rolledBack.verified = false; rolledBack.failed = [error.message] }
      }
      return { ok: false, phase: result.ok ? 'verify' : 'update', error: problem || result.error,
        output: result.output, backupDir: bk.dir, rolledBack, versions: { before, after, afterRollback: post } }
    }
    let patches
    try {
      const chk = checkAllPatches()
      patches = { total: chk.summary.total, applied: chk.summary.applied,
        missing: chk.results.filter((r) => r.status === 'missing').map((r) => r.patch.id),
        anchorMissing: chk.results.filter((r) => r.status === 'anchor-missing').map((r) => r.patch.id) }
    } catch (error) { patches = { error: error.message } }
    return { ok: true, backupDir: bk.dir, versions: { before, after }, command: result.args, output: result.output, patches }
  } catch (error) { return { ok: false, phase: ownsLock ? 'backup' : 'lock', error: error.message, backupDir: bk?.dir } }
  finally {
    if (ownsLock && canUnlock) { try { plainPath(lock); if (readFileSync(lock, 'utf8') === token) unlinkSync(lock) } catch {   } }
  }
}
function captureInstallation(dir, dependencies) {
  return captureProfile(dir, linkPolicy(dir, dependencies)).installation
}

export function renderUpdateReport(r) {
  const L = []
  if (!r) return '（没有结果）'

  if (r.error && !r.ok) {
    L.push('❌ 更新失败：' + r.error)
    if (r.phase) L.push('   失败阶段：' + r.phase)
    if (r.rolledBack) {
      L.push('   回滚：' + (r.rolledBack.ok
        ? 'profile声明与完整安装树已复验还原（目标 ' + (r.rolledBack.restored || []).length + ' 个包）'
        : '回滚也有问题 → ' + (r.rolledBack.failed || []).join('; ')))
    }
    if (r.versions) {
      L.push('   版本（更新前 → 更新后 → 回滚后）：')
      for (const [n, v] of Object.entries(r.versions.before)) {
        L.push('     ' + n + '：' + (v || '?') + ' → ' + (r.versions.after?.[n] || '?')
          + ' → ' + (r.versions.afterRollback?.[n] || '?'))
      }
    }
    if (r.output) {
      L.push('   命令输出（末段）：')
      for (const line of r.output.split('\n').slice(-15)) L.push('     ' + line)
    }
    return L.join('\n')
  }

  if (r.dryRun) {
    L.push('=== 更新预演（未执行）===')
    L.push('将执行：' + r.command)
    L.push('')
    L.push('将更新 ' + r.wouldUpdate.length + ' 个：')
    for (const u of r.wouldUpdate) L.push('  ' + u.name + '  ' + (u.from || '?') + ' → ' + u.to)
    return L.join('\n')
  }

  L.push('=== 更新完成 ===')
  L.push('已完成CLI与本地文件校验；安装脚本未执行，尚未验证真实宿主加载/插件行为。')
  L.push('备份：' + r.backupDir)
  L.push('')
  L.push('版本变化：')
  for (const [n, v] of Object.entries(r.versions.before)) {
    const a = r.versions.after[n]
    L.push('  ' + n + '：' + (v || '?') + ' → ' + (a || '?') + (v === a ? '（未变）' : ''))
  }
  if (r.patches && !r.patches.error) {
    L.push('')
    L.push('补丁复查：' + r.patches.applied + '/' + r.patches.total + ' 在线')
    if ((r.patches.missing || []).length) {
      L.push('  ⚠️ 掉线（锚点还在，可重放）：' + r.patches.missing.join(', '))
    }
    if ((r.patches.anchorMissing || []).length) {
      L.push('  ❌ 锚点失效（需要人工看）：' + r.patches.anchorMissing.join(', '))
    }
    if (!(r.patches.missing || []).length && !(r.patches.anchorMissing || []).length) {
      L.push('  ✅ 全部在线')
    }
  }
  if (r.patches?.error) L.push('⚠ 补丁复查失败：' + r.patches.error + '；不能据此断言补丁全部在线。')
  return L.join('\n')
}
