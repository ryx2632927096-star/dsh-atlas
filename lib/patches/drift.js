import {
  readFileSync, existsSync, mkdirSync, statSync, lstatSync, readdirSync, writeFileSync,
} from 'node:fs'
import { join, relative, sep, basename } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { atlasRoot } from '../core/paths.js'
import { safeFetchJson } from '../upstream/upstream.js'

export const TARBALL_ALLOWED_HOSTS = new Set(['registry.npmjs.org'])

export const MAX_TARBALL_BYTES = 20 * 1024 * 1024

const SKIP_DIRS = new Set(['node_modules', '.git', '.bin', '.pnpm'])

const BACKUP_RE = /\.(bak|orig|rej)([-.]|$)/i

export function isBackupFile(name) {
  return BACKUP_RE.test(basename(name))
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function slugify(text, max = 40) {
  const s = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s.slice(0, max).replace(/-+$/, '') || 'x'
}

function pluginDir(plugin) {
  const dir = plugin?.installedDir || plugin?.realDir || plugin?.dir
  if (!dir) throw new Error('plugin 缺少 installedDir/realDir，无法扫描')
  return dir
}

function resolveSourceType(plugin) {
  if (plugin?.sourceType) return plugin.sourceType
  try {
    return lstatSync(pluginDir(plugin)).isSymbolicLink() ? 'link-junction' : 'npm'
  } catch {
    return 'unknown'
  }
}

function walkFiles(root) {
  const files = []
  const stack = [root]
  let scanned = 0
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue
      const full = join(dir, entry.name)
      let st
      try {
        st = lstatSync(full)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!st.isFile()) continue
      scanned++
      files.push({
        rel: relative(root, full).split(sep).join('/'),
        size: st.size,
        nlink: st.nlink,
      })
    }
  }
  return { files, scanned }
}

export function scanLocalModifications(plugin) {
  const sourceType = resolveSourceType(plugin)

  if (sourceType !== 'npm') {
    return {
      modified: [],
      scanned: 0,
      backups: [],
      sourceType,
      reason: 'link 包（目录是 Junction/symlink），目录内所有文件 nlink 都是 1，'
        + 'nlink 启发式失效 —— 无法用硬链接数区分「本地改过」与「原样链接」',
    }
  }

  let walked
  try {
    walked = walkFiles(pluginDir(plugin))
  } catch (error) {
    return { modified: [], scanned: 0, backups: [], sourceType, reason: String(error?.message || error) }
  }

  const modified = []
  const backups = []
  for (const f of walked.files) {
    if (f.nlink !== 1) continue
    const record = { file: f.rel, size: f.size, nlink: f.nlink, reason: 'nlink-1' }
    if (isBackupFile(f.rel)) backups.push(record)
    else modified.push(record)
  }

  const sorted = (list) => list.sort((a, b) => a.file.localeCompare(b.file))
  return { modified: sorted(modified), scanned: walked.scanned, backups: sorted(backups), sourceType }
}


async function safeFetchBuffer(url, options = {}) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('非法 URL：' + url)
  }
  if (!TARBALL_ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error('拒绝下载：' + parsed.hostname + ' 不在白名单（只允许 '
      + [...TARBALL_ALLOWED_HOSTS].join(', ') + '）')
  }

  const maxBytes = options.maxBytes || MAX_TARBALL_BYTES
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 45000)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'dsh-atlas (local readonly)', accept: 'application/octet-stream' },
    })
    if (!res.ok) throw new Error(('HTTP ' + res.status + ' ' + (res.statusText || '')).trim())

    const finalHost = new URL(res.url).hostname
    if (!TARBALL_ALLOWED_HOSTS.has(finalHost)) {
      throw new Error('重定向到非白名单 host：' + finalHost)
    }

    const declared = Number(res.headers.get('content-length') || 0)
    if (declared && declared > maxBytes) {
      throw new Error('tarball 过大（' + declared + ' > ' + maxBytes + ' 字节），已拒绝下载')
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > maxBytes) {
      throw new Error('tarball 过大（' + buf.length + ' > ' + maxBytes + ' 字节），已丢弃')
    }
    return { buffer: buf, bytes: buf.length, url: res.url }
  } finally {
    clearTimeout(timeout)
  }
}


function readTarString(chunk) {
  const end = chunk.indexOf(0)
  const slice = end === -1 ? chunk : chunk.subarray(0, end)
  return slice.toString('utf8').trim()
}

function readTarNumber(chunk) {
  if (chunk.length && (chunk[0] & 0x80)) {
    let n = 0
    for (let i = 1; i < chunk.length; i++) n = n * 256 + chunk[i]
    return n
  }
  const s = readTarString(chunk).replace(/\0/g, '').trim()
  if (!s) return 0
  const n = Number.parseInt(s, 8)
  return Number.isFinite(n) ? n : 0
}

function parsePaxRecords(buf) {
  const out = {}
  let off = 0
  while (off < buf.length) {
    const space = buf.indexOf(0x20, off)
    if (space === -1) break
    const len = Number.parseInt(buf.subarray(off, space).toString('utf8'), 10)
    if (!Number.isFinite(len) || len <= 0) break
    const record = buf.subarray(space + 1, off + len - 1).toString('utf8')
    const eq = record.indexOf('=')
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1)
    off += len
  }
  return out
}

function parseTarGz(gzBuf) {
  const buf = gunzipSync(gzBuf)
  const files = new Map()
  let off = 0
  let paxPath = null
  let gnuName = null
  let blocks = 0

  while (off + 512 <= buf.length) {
    if (++blocks > 500000) throw new Error('tar 块数异常，疑似格式不受支持')
    const header = buf.subarray(off, off + 512)
    let allZero = true
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) { allZero = false; break }
    }
    if (allZero) break

    const typeflag = String.fromCharCode(header[156] || 0x30)
    const size = readTarNumber(header.subarray(124, 136))
    const dataStart = off + 512
    const dataEnd = dataStart + size
    if (dataEnd > buf.length) throw new Error('tar 数据块越界，疑似格式不受支持')
    const data = buf.subarray(dataStart, dataEnd)
    const next = dataStart + Math.ceil(size / 512) * 512

    if (typeflag === 'x') {
      const rec = parsePaxRecords(data)
      if (rec.path) paxPath = rec.path
      off = next
      continue
    }
    if (typeflag === 'g') { off = next; continue }
    if (typeflag === 'L') {
      gnuName = data.toString('utf8').replace(/\0+$/, '')
      off = next
      continue
    }
    if (typeflag === 'K') { off = next; continue }

    const nameRaw = readTarString(header.subarray(0, 100))
    const prefix = readTarString(header.subarray(345, 455))
    let name = paxPath || gnuName || (prefix ? prefix + '/' + nameRaw : nameRaw)
    paxPath = null
    gnuName = null

    if (typeflag === '5') { off = next; continue }
    if (typeflag === '0' || typeflag === '\u0000' || typeflag === '') {
      const clean = name.replace(/^\.\//, '')
      if (clean) files.set(clean, Buffer.from(data))
    }
    off = next
  }

  if (!files.size) throw new Error('tar 里没有解析出任何文件')
  return files
}

function extractWithSystemTar(tgzPath, destDir) {
  mkdirSync(destDir, { recursive: true })
  const exe = process.platform === 'win32' ? 'tar.exe' : 'tar'
  execFileSync(exe, ['-xzf', tgzPath, '-C', destDir], {
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 120000,
  })
  const files = new Map()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.isFile()) continue
      files.set(relative(destDir, full).split(sep).join('/'), readFileSync(full))
    }
  }
  walk(destDir)
  if (!files.size) throw new Error('系统 tar 解开后没有文件')
  return files
}

function normalizeTarballPaths(files) {
  const out = new Map()
  for (const [raw, buf] of files) {
    let key = raw.replace(/^\.\//, '')
    if (key.startsWith('package/')) key = key.slice('package/'.length)
    if (!key) continue
    out.set(key, buf)
  }
  return out
}


function looksText(buf) {
  const probe = buf.subarray(0, Math.min(buf.length, 1024))
  for (let i = 0; i < probe.length; i++) if (probe[i] === 0) return false
  return true
}

function lineSetDiff(localText, registryText) {
  const regLines = registryText.split(/\r?\n/)
  const counts = new Map()
  for (const line of regLines) counts.set(line, (counts.get(line) || 0) + 1)

  const localLines = localText.split(/\r?\n/)
  const localCounts = new Map()
  const added = []
  for (const line of localLines) {
    localCounts.set(line, (localCounts.get(line) || 0) + 1)
    const left = counts.get(line) || 0
    if (left > 0) {
      counts.set(line, left - 1)
      continue
    }
    added.push(line)
  }

  const removed = []
  for (const [line, left] of counts) {
    if (left <= 0) continue
    if (localCounts.has(line)) continue
    removed.push(line)
  }

  return {
    added, removed, localCounts,
    localLineCount: localLines.length,
    registryLineCount: regLines.length,
  }
}

function pickMarkerLine(diff) {
  const seen = new Map()
  for (const line of diff.added) seen.set(line, (seen.get(line) || 0) + 1)

  const candidates = diff.added
    .map((line) => ({ raw: line, trimmed: line.trim() }))
    .filter((l) => l.trimmed.length >= 16 && l.trimmed.length <= 140)
    .filter((l) => seen.get(l.raw) === 1 && diff.localCounts.get(l.raw) === 1)
    .filter((l) => !/^[}{)\],;]+$/.test(l.trimmed))
    .map((l) => l.trimmed)
  if (!candidates.length) return null
  const annotated = candidates.find((line) => /(本地|补丁|local|patch|fix|removed|modified)/i.test(line))
  return annotated || candidates[0]
}

function pickHeuristicMarker(content) {
  const lines = content.split(/\r?\n/)
  const hits = lines.filter((line) => {
    const t = line.trim()
    return t.length >= 16 && t.length <= 140
      && /(\[本地补丁\]|本地补丁|local fix|local patch|locally|本地改动|patched locally)/i.test(t)
  })
  return hits.length ? hits[0].trim() : null
}


export async function diffAgainstRegistry(plugin, options = {}) {
  const started = Date.now()
  const cacheDir = options.cacheDir || join(atlasRoot(), 'cache', 'tarballs')
  const sourceType = resolveSourceType(plugin)

  if (sourceType !== 'npm') {
    return {
      status: 'unavailable', changed: [], added: [], removed: [],
      detail: 'link 包：本地目录是源码仓库的 Junction，与 registry 发布的文件集不是同一套，'
        + '逐文件比对只会产出噪音，因此不做',
      elapsedMs: Date.now() - started,
    }
  }

  const name = plugin?.id || plugin?.name
  const version = plugin?.version
  if (!name || !version) {
    return {
      status: 'unavailable', changed: [], added: [], removed: [],
      detail: '插件缺少 name 或 version，无法定位 registry 上的对应版本',
      elapsedMs: Date.now() - started,
    }
  }

  const cacheFile = join(cacheDir, slugify(name) + '@' + slugify(version) + '.tgz')
  let tgzBuf = null
  const tarball = { url: null, bytes: 0, cached: false, ms: 0 }
  const netStart = Date.now()

  try {
    if (existsSync(cacheFile)) {
      const st = statSync(cacheFile)
      if (st.size > 0) {
        tgzBuf = readFileSync(cacheFile)
        tarball.cached = true
        tarball.bytes = st.size
        tarball.url = cacheFile
      }
    }

    if (!tgzBuf) {
      const encoded = name.startsWith('@') ? name.replace('/', '%2F') : name
      const meta = await safeFetchJson(
        'https://registry.npmjs.org/' + encoded + '/' + version,
        { timeoutMs: options.timeoutMs || 20000 },
      )
      const url = meta && meta.dist && meta.dist.tarball
      if (!url) {
        return {
          status: 'unavailable', changed: [], added: [], removed: [],
          detail: 'registry 上没有 ' + name + '@' + version + ' 的 dist.tarball（这个版本可能未发布）',
          elapsedMs: Date.now() - started,
        }
      }
      const got = await safeFetchBuffer(url, {
        timeoutMs: options.timeoutMs || 60000,
        maxBytes: options.maxBytes || MAX_TARBALL_BYTES,
      })
      tgzBuf = got.buffer
      tarball.url = got.url
      tarball.bytes = got.bytes
      mkdirSync(cacheDir, { recursive: true })
      writeFileSync(cacheFile, tgzBuf)
    }
  } catch (error) {
    return {
      status: 'error', changed: [], added: [], removed: [],
      error: String(error?.message || error).slice(0, 300),
      detail: '未能取到 registry 上的同版本 tarball，比对没有发生',
      elapsedMs: Date.now() - started,
    }
  }
  tarball.ms = Date.now() - netStart

  let tarFiles
  let method
  try {
    tarFiles = parseTarGz(tgzBuf)
    method = 'node-tar'
  } catch (error) {
    const nodeError = String(error?.message || error)
    try {
      const unpackDir = join(cacheDir, slugify(name) + '@' + slugify(version) + '.unpacked')
      tarFiles = extractWithSystemTar(cacheFile, unpackDir)
      method = 'system-tar'
    } catch (error2) {
      return {
        status: 'unavailable', changed: [], added: [], removed: [],
        detail: '两条解包路径都不成立，无法比对：纯 Node 解析失败（' + nodeError
          + '）；系统 tar 失败（' + String(error2?.message || error2) + '）',
        elapsedMs: Date.now() - started,
      }
    }
  }
  const registryFiles = normalizeTarballPaths(tarFiles)

  const root = pluginDir(plugin)
  const walked = walkFiles(root)
  const localMap = new Map(walked.files.map((f) => [f.rel, f]))

  const changed = []
  const added = []
  const removed = []
  const backupFiles = []
  let unchanged = 0
  let compared = 0

  for (const [rel, regBuf] of registryFiles) {
    const local = localMap.get(rel)
    if (!local) {
      removed.push(rel)
      continue
    }
    let localBuf
    try {
      localBuf = readFileSync(join(root, rel.split('/').join(sep)))
    } catch {
      removed.push(rel)
      continue
    }
    compared++
    if (localBuf.equals(regBuf)) {
      unchanged++
      continue
    }

    const modFile = {
      file: rel,
      size: local.size,
      nlink: local.nlink,
      reason: 'tarball-diff',
      registrySize: regBuf.length,
    }
    if (looksText(localBuf) && looksText(regBuf) && localBuf.length < 4 * 1024 * 1024) {
      const diff = lineSetDiff(localBuf.toString('utf8'), regBuf.toString('utf8'))
      modFile.diff = {
        addedLines: diff.added.length,
        removedLines: diff.removed.length,
        localLineCount: diff.localLineCount,
        registryLineCount: diff.registryLineCount,
        markerLine: pickMarkerLine(diff),
        sample: diff.added.slice(0, 3).map((l) => l.trim()).filter(Boolean),
      }
    } else {
      modFile.diff = { binary: true, addedLines: 0, removedLines: 0, markerLine: null, sample: [] }
    }
    changed.push(modFile)
  }

  for (const f of walked.files) {
    if (registryFiles.has(f.rel)) continue
    if (f.rel.startsWith('.git/')) continue
    if (isBackupFile(f.rel)) {
      backupFiles.push({ file: f.rel, size: f.size, nlink: f.nlink, reason: 'backup' })
      continue
    }
    added.push(f.rel)
  }

  const byFile = (a, b) => String(a.file || a).localeCompare(String(b.file || b))
  changed.sort(byFile)
  added.sort()
  removed.sort()

  const textChanged = changed.filter((c) => c.diff && !c.diff.binary)
  const parts = []
  parts.push('registry ' + name + '@' + version + ' 有 ' + registryFiles.size
    + ' 个文件，本地 ' + walked.scanned + ' 个')
  parts.push('比对 ' + compared + ' 个同名文件：一致 ' + unchanged + '，不一致 ' + changed.length)
  if (added.length) parts.push('本地多出 ' + added.length + ' 个文件')
  if (removed.length) parts.push('本地缺少 ' + removed.length + ' 个文件')
  if (textChanged.length) {
    const head = textChanged.slice(0, 5)
      .map((c) => c.file + '(+' + c.diff.addedLines + '/-' + c.diff.removedLines + ')')
      .join('、')
    parts.push('变了的是：' + head + (textChanged.length > 5 ? ' …' : ''))
  }
  if (!changed.length && !added.length && !removed.length) {
    parts.push('与 registry 版本完全一致，没有本地改动')
  }

  return {
    status: 'ok',
    changed, added, removed,
    detail: parts.join('；'),
    method,
    tarball,
    compared,
    unchanged,
    registryFileCount: registryFiles.size,
    localFileCount: walked.scanned,
    backups: backupFiles,
    elapsedMs: Date.now() - started,
  }
}


export function generatePatchRecord(plugin, modFile, options = {}) {
  const pkgName = plugin?.id || plugin?.name || 'unknown'
  const rel = String(modFile?.file || '').replace(/\\/g, '/')
  if (!rel) throw new Error('generatePatchRecord 需要 modFile.file')

  const id = 'drift-' + slugify(pkgName, 32) + '-' + slugify(rel, 40)

  let markerLine = modFile?.diff?.markerLine || null
  let markerSource = markerLine ? 'tarball-diff' : null

  if (!markerLine && typeof options.localContent === 'string') {
    markerLine = pickHeuristicMarker(options.localContent)
    if (markerLine) markerSource = 'heuristic-comment'
  }
  if (!markerLine && typeof options.localContent === 'string') {
    const firstLine = options.localContent.split(/\r?\n/).find((l) => l.trim().length >= 8) || ''
    if (firstLine.trim()) {
      markerLine = firstLine.trim().slice(0, 120)
      markerSource = 'weak-firstline'
    }
  }

  const record = {
    id,
    name: pkgName + ' · ' + rel + ' 的本地改动（自动发现草稿）',
    severity: 'low',
    target: 'profile:' + pkgName + '/' + rel,
    why: modFile?.reason === 'tarball-diff'
      ? '自动发现：该文件内容与 registry 同版本 tarball 不一致'
      : '自动发现：该文件硬链接数异常（nlink=1），说明安装后被写过一次',
    marker: markerLine ? escapeRegex(markerLine) : 'dsh-atlas-drift-no-marker',
    manual: true,
    _generated: true,
    _markerSource: markerSource || 'none',
    _markerText: markerLine || null,
    _discovered: {
      by: modFile?.reason || 'unknown',
      at: new Date().toISOString(),
      version: plugin?.version || null,
      sha256: typeof options.localContent === 'string'
        ? sha256(Buffer.from(options.localContent))
        : null,
      size: modFile?.size ?? null,
      nlink: modFile?.nlink ?? null,
    },
  }

  if (modFile?.reason === 'tarball-diff' && modFile.diff) {
    record._diff = {
      addedLines: modFile.diff.addedLines ?? null,
      removedLines: modFile.diff.removedLines ?? null,
      sample: modFile.diff.sample || [],
    }
  }

  return record
}
