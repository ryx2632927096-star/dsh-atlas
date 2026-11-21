import { lstatSync, readdirSync, readFileSync, readlinkSync, mkdirSync, copyFileSync,
  symlinkSync, chmodSync, constants } from 'node:fs'
import { resolve, relative, isAbsolute, dirname, join, sep } from 'node:path'
import { createHash } from 'node:crypto'

export function present(path) {
  try { lstatSync(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
export function inside(root, path, allowRoot = false) {
  const rel = relative(resolve(root), resolve(path))
  return (allowRoot && !rel) || Boolean(rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}
export function contained(root, path) {
  if (!inside(root, path)) throw new Error('路径不在允许的根目录内')
  return resolve(path)
}
export function plainPath(path) {
  const full = resolve(path)
  const parts = []
  for (let p = full; ; p = dirname(p)) { parts.unshift(p); if (p === dirname(p)) break }
  for (let i = 0; i < parts.length; i++) {
    if (!present(parts[i])) break
    const st = lstatSync(parts[i])
    if (st.isSymbolicLink()) throw new Error('路径含符号链接/Junction，拒绝写入')
    if (i < parts.length - 1 && !st.isDirectory()) throw new Error('祖先路径不是目录')
  }
  return full
}
export function digest(file) { return createHash('sha256').update(readFileSync(file)).digest('hex') }
function mode(st) { return st.mode & 0o777 }
function itemPath(root, name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.split('/').some((p) => !p || p === '.' || p === '..')) {
    throw new Error('清单含非法相对路径')
  }
  return contained(root, join(root, ...name.split('/')))
}
export function tree(root, { allowLink = () => false, maxBytes = Infinity } = {}) {
  plainPath(root)
  if (!lstatSync(root).isDirectory()) throw new Error('快照源不是目录')
  const entries = []
  let bytes = 0
  function walk(dir, prefix) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), rel = prefix ? prefix + '/' + name : name
      const st = lstatSync(path)
      if (st.isSymbolicLink()) {
        const target = readlinkSync(path)
        const resolvedTarget = resolve(dirname(path), target)
        if (!allowLink(rel, resolvedTarget)) throw new Error('快照中存在未获准的外部链接：' + rel)
        entries.push({ path: rel, kind: 'link', target })
      } else if (st.isDirectory()) {
        entries.push({ path: rel, kind: 'directory' }); walk(path, rel)
      } else if (st.isFile()) {
        bytes += st.size
        if (bytes > maxBytes) throw new Error('快照超过容量上限')
        entries.push({ path: rel, kind: 'file', bytes: st.size, hash: digest(path), mode: mode(st) })
      } else throw new Error('不支持的文件类型：' + rel)
    }
  }
  walk(root, '')
  return { entries, bytes }
}
export function verifyTree(root, expected, options = {}) {
  const actual = tree(root, { allowLink: () => true, ...options })
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('文件清单/内容哈希与快照不一致')
  return actual
}
export function cloneTree(source, destination, manifest) {
  plainPath(source); plainPath(destination)
  if (present(destination)) throw new Error('快照目标已存在')
  mkdirSync(destination, { recursive: true })
  for (const entry of manifest.entries) {
    const src = itemPath(source, entry.path), dst = itemPath(destination, entry.path)
    plainPath(dirname(dst))
    if (entry.kind === 'directory') mkdirSync(dst)
    else if (entry.kind === 'file') {
      plainPath(src)
      copyFileSync(src, dst, constants.COPYFILE_EXCL)
      chmodSync(dst, entry.mode)
    } else if (entry.kind === 'link') {
      if (typeof entry.target !== 'string') throw new Error('链接清单损坏')
      symlinkSync(entry.target, dst, process.platform === 'win32' && isAbsolute(entry.target) ? 'junction' : undefined)
    } else throw new Error('未知清单类型')
  }
  verifyTree(destination, manifest)
  verifyTree(source, manifest)
}
