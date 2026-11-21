import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { dshHome, atlasRoot } from '../core/paths.js'

export function sessionsDir() {
  return join(dshHome(), "sessions")
}

export function backupRoot() {
  return join(atlasRoot(), "sessions-backup")
}

export function fingerprint() {
  const dir = sessionsDir()
  if (!existsSync(dir)) return { ok: false, files: 0, bytes: 0, newest: 0, dirs: 0, reason: "没有 sessions 目录" }
  let files = 0
  let bytes = 0
  let newest = 0
  let dirs = 0
  const walk = (d, lv) => {
    if (lv > 3) return
    let ents
    try { ents = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const f = join(d, e.name)
      if (e.isDirectory()) { dirs += 1; walk(f, lv + 1); continue }
      files += 1
      try {
        const st = statSync(f)
        bytes += st.size
        if (st.mtimeMs > newest) newest = st.mtimeMs
      } catch {   }
    }
  }
  walk(dir, 0)
  return { ok: true, files, bytes, newest, dirs }
}

export function compare(before, after) {
  const changes = []
  if (!before || !after) return { same: false, changes: ["指纹算不出来"] }
  if (before.files !== after.files) changes.push(`文件数 ${before.files} → ${after.files}`)
  if (before.dirs !== after.dirs) changes.push(`子目录数 ${before.dirs} → ${after.dirs}`)
  return { same: changes.length === 0, changes }
}

export function compareStrict(before, after) {
  const base = compare(before, after)
  const changes = [...base.changes]
  if (base.same && before && after && before.bytes !== after.bytes) {
    changes.push(`总字节 ${before.bytes} → ${after.bytes}`)
  }
  return { same: changes.length === 0, changes }
}

export { backup, listBackups, restore } from './session-backup.js'
