import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { snapshotsDir, resolveTarget, fileHash } from './patches.js'
import { atlasRoot } from '../core/paths.js'

function tsLabel(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

export function createSnapshot(patches, options = {}) {
  const root = options.root || atlasRoot()
  const label = options.label || 'auto'
  const dir = join(snapshotsDir(root), `${tsLabel()}-${label}`)
  mkdirSync(dir, { recursive: true })

  const manifest = {
    at: Date.now(),
    label,
    files: [],
    missing: [],
  }

  const targets = new Set()
  for (const p of patches || []) {
    try {
      targets.add(resolveTarget(p.target))
    } catch {
      manifest.missing.push({ spec: p.target, reason: 'target 无法解析' })
    }
  }
  for (const f of options.extraFiles || []) targets.add(f)

  let index = 0
  for (const file of targets) {
    if (!existsSync(file)) {
      manifest.missing.push({ spec: file, reason: '不存在' })
      continue
    }
    const base = basename(file)
    const saved = `${String(index++).padStart(3, '0')}-${base}`
    try {
      copyFileSync(file, join(dir, saved))
      const st = statSync(file)
      manifest.files.push({
        original: file,
        saved,
        sha256: fileHash(file),
        size: st.size,
        mtimeMs: Math.floor(st.mtimeMs),
      })
    } catch (error) {
      manifest.missing.push({ spec: file, reason: String(error.message) })
    }
  }

  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return { dir, manifest }
}

export function listSnapshots(root = atlasRoot()) {
  const dir = snapshotsDir(root)
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    try {
      if (!statSync(full).isDirectory()) continue
      const manifestPath = join(full, 'manifest.json')
      if (!existsSync(manifestPath)) continue
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      out.push({ name, dir: full, ...manifest })
    } catch {   }
  }
  return out.sort((a, b) => (b.at || 0) - (a.at || 0))
}

export function diffSnapshot(snapshotDir) {
  const manifestPath = join(snapshotDir, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error('快照缺少 manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

  const result = { unchanged: 0, changed: [], missing: [] }
  for (const entry of manifest.files || []) {
    if (!existsSync(entry.original)) {
      result.missing.push({ file: entry.original, saved: entry.saved })
      continue
    }
    const now = fileHash(entry.original)
    if (now === entry.sha256) { result.unchanged++; continue }
    result.changed.push({
      file: entry.original,
      saved: join(snapshotDir, entry.saved),
      before: entry.sha256,
      after: now,
    })
  }
  return result
}

export function restoreFromSnapshot(snapshotDir, originalPath) {
  const manifestPath = join(snapshotDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const entry = (manifest.files || []).find((f) => f.original === originalPath)
  if (!entry) throw new Error(`快照里没有这个文件：${originalPath}`)

  const saved = join(snapshotDir, entry.saved)
  if (!existsSync(saved)) throw new Error(`快照文件已丢失：${saved}`)

  mkdirSync(dirname(originalPath), { recursive: true })
  if (existsSync(originalPath)) {
    copyFileSync(originalPath, `${originalPath}.bak-atlas-${Date.now()}`)
  }
  copyFileSync(saved, originalPath)
  return { restored: originalPath, from: saved, sha256: fileHash(originalPath) }
}

export function removeSnapshot(snapshotDir) {
  rmSync(snapshotDir, { recursive: true, force: true })
}
