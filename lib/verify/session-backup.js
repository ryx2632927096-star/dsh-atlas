import { mkdirSync, readdirSync, readFileSync, writeFileSync, lstatSync, copyFileSync,
  renameSync, chmodSync, constants } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dshHome, atlasRoot } from '../core/paths.js'
import { present, plainPath, contained, inside, tree, cloneTree, verifyTree } from '../core/safe-tree.js'

const MANIFEST = '.atlas-session-manifest.json'
const nameOk = (name) => typeof name === 'string' && /^sessions-[A-Za-z0-9-]+$/.test(name)
const rootDir = () => join(atlasRoot(), 'sessions-backup')
const sourceDir = () => join(dshHome(), 'sessions')
function paths() {
  const source = plainPath(sourceDir()), root = plainPath(rootDir())
  if (inside(source, root, true) || inside(root, source, true)) throw new Error('会话目录和备份目录不能重叠')
  return { source, root }
}
function readBackup(name) {
  if (!nameOk(name)) throw new Error('备份名不合法，不能包含路径')
  const { source, root } = paths()
  const dir = contained(root, join(root, name))
  plainPath(dir)
  if (!present(dir)) throw new Error('备份不存在')
  if (present(join(dir, MANIFEST))) {
    plainPath(join(dir, MANIFEST))
    const saved = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8'))
    if (saved.version !== 1) throw new Error('备份格式不支持')
    const data = join(dir, 'data')
    verifyTree(data, saved.tree, { allowLink: () => false })
    return { source, dir, data, manifest: saved.tree, kind: saved.kind, legacy: false }
  }
  if (name.startsWith('sessions-v1-')) throw new Error('备份未完成，不能列为有效备份或恢复')
  return { source, dir, data: dir, manifest: tree(dir), kind: 'legacy', legacy: true }
}

export function backup(options = {}) {
  let dir
  try {
    const { source, root } = paths()
    if (!present(source)) throw new Error('没有 sessions 目录，无从备份')
    const manifest = tree(source, { maxBytes: options.maxBytes ?? 512 * 1024 * 1024 })
    const name = 'sessions-v1-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID()
    dir = contained(root, join(root, name))
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    cloneTree(source, join(dir, 'data'), manifest)
    writeFileSync(join(dir, MANIFEST), JSON.stringify({ version: 1, kind: options.kind || 'backup', tree: manifest }), { flag: 'wx', mode: 0o600 })
    readBackup(name)
    return { ok: true, dir, files: manifest.entries.filter((e) => e.kind === 'file').length, bytes: manifest.bytes, pruned: [] }
  } catch (error) { return { ok: false, dir, reason: error.message } }
}

export function listBackups() {
  try {
    const { root } = paths()
    if (!present(root)) return []
    return readdirSync(root).filter(nameOk).map((name) => {
      try {
        const b = readBackup(name)
        return { name, path: b.dir, mtime: lstatSync(b.dir).mtimeMs, bytes: b.manifest.bytes,
          files: b.manifest.entries.filter((e) => e.kind === 'file').length, kind: b.kind, verified: !b.legacy }
      } catch { return null }
    }).filter(Boolean).sort((a, b) => b.mtime - a.mtime)
  } catch { return [] }
}

export function restore(name) {
  let safetyBackup, files = 0
  try {
    const b = readBackup(name)
    if (present(b.source)) {
      tree(b.source)
      const safety = backup({ kind: 'before-restore', maxBytes: Infinity })
      if (!safety.ok) throw new Error('恢复前保护失败，未覆盖会话：' + safety.reason)
      safetyBackup = safety.dir
    }
    verifyTree(b.data, b.manifest, { allowLink: () => false })
    for (const e of b.manifest.entries) {
      const dst = contained(b.source, resolve(b.source, e.path))
      plainPath(dst)
      if (present(dst) && (e.kind === 'directory') !== lstatSync(dst).isDirectory()) throw new Error('恢复目标文件/目录类型冲突')
    }
    mkdirSync(b.source, { recursive: true })
    for (const e of b.manifest.entries) {
      const dst = contained(b.source, join(b.source, ...e.path.split('/')))
      plainPath(dst)
      if (e.kind === 'directory') { mkdirSync(dst, { recursive: true }); continue }
      const tmp = contained(b.source, join(dirname(dst), '.atlas-restore-' + randomUUID()))
      copyFileSync(join(b.data, ...e.path.split('/')), tmp, constants.COPYFILE_EXCL)
      chmodSync(tmp, e.mode)
      renameSync(tmp, dst)
      files++
    }
    const actual = tree(b.source)
    for (const e of b.manifest.entries) {
      const match = actual.entries.find((a) => a.path === e.path)
      if (JSON.stringify(match) !== JSON.stringify(e)) throw new Error('恢复后哈希复验不一致')
    }
    return { ok: true, files, safetyBackup, legacy: b.legacy }
  } catch (error) { return { ok: false, files, partial: files > 0, safetyBackup, reason: error.message } }
}
