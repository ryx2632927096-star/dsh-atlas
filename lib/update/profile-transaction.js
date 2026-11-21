import { readFileSync, writeFileSync, mkdirSync, copyFileSync, lstatSync, renameSync, chmodSync, constants } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { plainPath, present, inside, contained, tree, cloneTree, verifyTree, digest } from '../core/safe-tree.js'

export const PROFILE_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package-lock.json',
  'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb', 'cordis.patch.yml', 'cordis.yml',
  'compatibility.json', 'version-exemptions.json', '.dsh-profile-compatibility.json', '.dsh-plugin-compatibility.json']

export function linkPolicy(dir, dependencies) {
  const nm = join(dir, 'node_modules')
  const external = new Map()
  for (const [name, spec] of Object.entries(dependencies)) {
    if (!/^(link|file|portal|workspace):/.test(spec)) continue
    const path = contained(nm, join(nm, name))
    try {
      const st = lstatSync(path)
      if (st.isSymbolicLink()) {
        external.set(name, null)
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return (rel, target) => inside(nm, target, true) || external.has(rel)
}
export function captureProfile(dir, allowLink) {
  plainPath(dir)
  const files = PROFILE_FILES.map((name) => {
    const path = join(dir, name)
    plainPath(path)
    if (!present(path)) return { name, exists: false }
    const st = lstatSync(path)
    if (!st.isFile()) throw new Error('profile配置不是普通文件：' + name)
    return { name, exists: true, hash: digest(path), bytes: st.size, mode: st.mode & 0o777 }
  })
  return { files, installation: tree(join(dir, 'node_modules'), { allowLink }) }
}
export function sameProfile(dir, expected, allowLink) {
  const actual = captureProfile(dir, allowLink)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('profile配置/安装树与前态不一致')
  return true
}

export function makeSnapshot(dir, destination, names, dependencies, options = {}) {
  plainPath(dir); plainPath(destination)
  if (inside(dir, destination, true) || inside(destination, dir, true)) throw new Error('事务备份目录不能与profile重叠')
  if (present(destination)) throw new Error('事务备份目录已存在')
  const allowLink = linkPolicy(dir, dependencies)
  const before = captureProfile(dir, allowLink)
  mkdirSync(join(destination, 'files'), { recursive: true, mode: 0o700 })
  for (const file of before.files) if (file.exists) {
    copyFileSync(join(dir, file.name), join(destination, 'files', file.name), constants.COPYFILE_EXCL)
    chmodSync(join(destination, 'files', file.name), file.mode)
  }
  const copier = options.copyTree || cloneTree
  copier(join(dir, 'node_modules'), join(destination, 'node_modules'), before.installation)
  verifyPayload(destination, before)
  sameProfile(dir, before, allowLink)
  const manifest = { version: 1, profile: resolve(dir), names, before }
  writeFileSync(join(destination, 'transaction.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 })
  return manifest
}
function verifyPayload(root, before) {
  plainPath(root)
  if (!before || before.files?.length !== PROFILE_FILES.length
    || before.files.some((f, i) => f.name !== PROFILE_FILES[i])) throw new Error('事务配置清单损坏')
  for (const file of before.files) {
    const path = join(root, 'files', file.name)
    plainPath(path)
    if (file.exists && (!present(path) || !lstatSync(path).isFile() || digest(path) !== file.hash)) {
      throw new Error('事务配置备份不完整：' + file.name)
    }
  }
  verifyTree(join(root, 'node_modules'), before.installation)
}
export function readSnapshot(root, dir, names) {
  plainPath(root); plainPath(join(root, 'transaction.json'))
  const saved = JSON.parse(readFileSync(join(root, 'transaction.json'), 'utf8'))
  if (saved.version !== 1 || resolve(saved.profile) !== resolve(dir)
    || JSON.stringify(saved.names) !== JSON.stringify(names)) throw new Error('事务备份与目标profile/包集合不匹配')
  verifyPayload(root, saved.before)
  return saved
}

export function restoreSnapshot(root, dir, names) {
  let displaced
  try {
    plainPath(dir)
    const saved = readSnapshot(root, dir, names)
    const id = randomUUID()
    const stage = contained(dir, join(dir, '.atlas-restore-' + id))
    displaced = contained(dir, join(dir, '.atlas-displaced-' + id))
    for (const file of PROFILE_FILES) plainPath(join(dir, file))
    plainPath(join(dir, 'node_modules'))
    const currentInstallation = present(join(dir, 'node_modules'))
    if (currentInstallation) tree(join(dir, 'node_modules'), { allowLink: () => true })
    mkdirSync(stage)
    cloneTree(join(root, 'node_modules'), join(stage, 'node_modules'), saved.before.installation)
    mkdirSync(join(stage, 'files'))
    for (const file of saved.before.files) if (file.exists) {
      copyFileSync(join(root, 'files', file.name), join(stage, 'files', file.name), constants.COPYFILE_EXCL)
      chmodSync(join(stage, 'files', file.name), file.mode)
    }
    verifyPayload(stage, saved.before)
    mkdirSync(displaced)
    if (currentInstallation) renameSync(join(dir, 'node_modules'), join(displaced, 'node_modules'))
    renameSync(join(stage, 'node_modules'), join(dir, 'node_modules'))
    for (const file of saved.before.files) {
      const dst = join(dir, file.name)
      plainPath(dst)
      if (present(dst)) renameSync(dst, join(displaced, file.name))
      if (file.exists) renameSync(join(stage, 'files', file.name), dst)
    }
    sameProfile(dir, saved.before, () => true)
    return { ok: true, verified: true, restored: names, displaced }
  } catch (error) { return { ok: false, verified: false, failed: [error.message], displaced } }
}
