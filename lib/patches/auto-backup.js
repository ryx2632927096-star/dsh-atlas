import { existsSync, copyFileSync } from "node:fs"
import { randomUUID } from 'node:crypto'
import { join, basename } from "node:path"
import { plainPath, contained, digest } from '../core/safe-tree.js'
import { dshHome } from '../core/paths.js'

function profileDir(profileName) {
  const name = profileName || 'desktop'
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error('profile名不合法')
  return contained(join(dshHome(), 'profiles'), join(dshHome(), 'profiles', name))
}


export function backupFile(file, options = {}) {
  if (!file) return { ok: false, reason: "没有文件路径" }
  if (!existsSync(file)) return { ok: false, reason: "文件不存在：" + file }
  const tag = options.tag || "config"
  if (!/^[a-zA-Z0-9-]+$/.test(tag)) return { ok: false, reason: '备份标识不合法' }
  const dst = file + ".bak-atlas-" + tag + "-" + randomUUID()
  try {
    plainPath(file); plainPath(dst)
    copyFileSync(file, dst)
    if (digest(file) !== digest(dst)) throw new Error('备份内容哈希不一致')
    return { ok: true, backup: dst }
  } catch (error) {
    return { ok: false, reason: String((error && error.message) || error) }
  }
}

export function backupBeforeWrite(options = {}) {
  let dir
  try { dir = profileDir(options.profileName) }
  catch (error) { return { ok: false, made: [], pruned: [], failed: [error.message] } }
  const files = Array.isArray(options.files) && options.files.length
    ? options.files
    : ["package.json", "cordis.patch.yml"]
  const made = []
  const pruned = []

  if (!existsSync(dir)) return { ok: false, made, pruned, dir }

  const failed = []
  try {
    plainPath(dir)
    for (const name of files) {
      if (!['package.json', 'cordis.patch.yml', 'cordis.yml'].includes(name)) throw new Error('备份文件名不受支持')
      const src = plainPath(contained(dir, join(dir, name)))
      if (!existsSync(src)) throw new Error('必需备份文件不存在：' + name)
    }
  } catch (error) { return { ok: false, made, pruned, dir, failed: [error.message] } }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID()
  for (const name of files) {
    const src = join(dir, name), dst = src + '.bak-atlas-' + stamp
    try {
      plainPath(src); plainPath(dst)
      copyFileSync(src, dst)
      if (digest(src) !== digest(dst)) throw new Error('备份内容哈希不一致')
      made.push(basename(dst))
    } catch (error) { failed.push(name + '：' + error.message) }
  }
  return { ok: failed.length === 0 && made.length === files.length, made, pruned, dir, failed }

}

export async function withBackup(options, action) {
  const bak = backupBeforeWrite(options)
  if (!bak.ok) return { ok: false, error: '备份不完整，未执行写操作', backups: bak.made }
  try {
    const result = await action()
    return { ok: result?.ok !== false, result, backups: bak.made }
  } catch (error) {
    return {
      ok: false,
      error: String((error && error.message) || error),
      backups: bak.made,
    }
  }
}
