import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readdirSync } from 'node:fs'

export const MIN_NODE = '24.9.0'

export function checkNodeVersion() {
  const current = process.versions.node
  const [major = 0, minor = 0] = current.split('.').map((n) => Number.parseInt(n, 10))
  const [needMajor = 0, needMinor = 0] = MIN_NODE.split('.').map((n) => Number.parseInt(n, 10))
  if (major > needMajor || (major === needMajor && minor >= needMinor)) return null
  return `dsh-atlas 需要 Node >= ${MIN_NODE}（当前 ${current}）。`
    + ' 插件用到 node:sqlite 与 zlib 的 zstd 支持，低版本会找不到模块。'
    + ' 升级 Node 后重启 DSH 即可。'
}

export function dshHome() {
  const env = process.env.DSH_HOME
  if (env && env.trim()) return env.trim()
  return join(homedir(), '.dsh')
}

export function currentProfile() {
  const env = process.env.DSH_PROFILE
  if (env && env.trim()) return env.trim()
  return autoDetectProfile() || 'desktop'
}

function autoDetectProfile() {
  let profilesDir
  try {
    profilesDir = join(dshHome(), 'profiles')
    if (!existsSync(profilesDir)) return null
  } catch { return null }

  let best = null
  let bestCount = -1
  let ents
  try { ents = readdirSync(profilesDir, { withFileTypes: true }) } catch { return null }
  for (const e of ents) {
    if (!e.isDirectory()) continue
    const nm = join(profilesDir, e.name, 'node_modules')
    if (!existsSync(nm)) continue
    let count = 0
    try { count = readdirSync(nm).length } catch { continue }
    if (count > bestCount) { bestCount = count; best = e.name }
  }
  return best
}

export function profileDir() {
  const env = process.env.DSH_PROFILE_DIR
  if (env && env.trim()) return env.trim()
  return join(dshHome(), 'profiles', currentProfile())
}

export function profileNodeModules() {
  return join(profileDir(), 'node_modules')
}

export function atlasRoot() {
  const env = process.env.DSH_ATLAS_HOME
  if (env && env.trim()) return env.trim()
  return join(dshHome(), 'dsh-atlas')
}

export function sessionsRoot() {
  const env = process.env.DSH_SESSIONS_ROOT
  if (env && env.trim()) return env.trim()
  return join(dshHome(), 'sessions')
}

export const DB_FILE = 'index/atlas.db'
export const REPORT_DIR = 'reports'
export const SNAPSHOT_DIR = 'snapshots'
export const PATCH_DIR = 'patches'
export const KNOWLEDGE_DIR = 'knowledge'

export const SUPPORTED_V4 = 4
