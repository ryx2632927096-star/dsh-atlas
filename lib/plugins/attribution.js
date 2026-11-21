import { readdirSync, lstatSync, readFileSync, statSync } from 'node:fs'
import { join, relative, basename } from 'node:path'
import { openDb } from '../observe/scan.js'

const MAX_DEPTH = 3

const MAX_FILE_BYTES = 8 * 1024 * 1024

const SKIP_DIRS = new Set(['node_modules', '.bin', '.git'])

const SKIP_SUFFIX = ['.map']

function nameFieldRe(tool) {
  return new RegExp('name\\s*:\\s*[\'"`]' + escapeRe(tool) + '[\'"`]')
}

function registerRe(tool) {
  return new RegExp('register\\s*\\(\\s*[\'"`]' + escapeRe(tool) + '[\'"`]')
}

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function collectFiles(rootDir, warnings, pluginId) {
  const out = []
  const seen = new Set()

  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return
    if (seen.has(dir)) return
    seen.add(dir)

    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch (error) {
      warnings.push(`${pluginId}：目录读不到（${dir}）：${String(error.message).slice(0, 100)}`)
      return
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue
      const full = join(dir, entry.name)

      let st
      try { st = lstatSync(full) } catch { continue }

      let isDir = st.isDirectory()
      if (!isDir && st.isSymbolicLink()) {
        try { isDir = statSync(full).isDirectory() } catch { isDir = false }
      }

      if (isDir) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(full, depth + 1)
        continue
      }

      if (!st.isFile()) continue
      if (SKIP_SUFFIX.some((s) => full.endsWith(s))) continue
      if (st.size > MAX_FILE_BYTES) continue
      out.push(full)
    }
  }

  walk(rootDir, 0)
  return out
}

export function attributeTools(plugins, toolNames, options = {}) {
  const includeRegisterCall = options.includeRegisterCall !== false
  const warnings = []
  const owners = []
  const ambiguous = []
  const unattributed = []
  let scannedFiles = 0

  const names = Array.isArray(toolNames)
    ? [...new Set(toolNames.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()))]
    : []
  if (!names.length) {
    warnings.push('没有可归属的工具名（toolNames 为空）')
    return { owners, ambiguous, unattributed, scannedFiles, warnings }
  }
  if (!Array.isArray(plugins) || !plugins.length) {
    warnings.push('没有插件可查（plugins 为空）')
    return { owners, ambiguous, unattributed: names, scannedFiles, warnings }
  }

  const hits = new Map(names.map((t) => [t, new Map()]))

  const alternation = names.map((t) => escapeRe(t)).join('|')
  const anyToolRe = new RegExp('(?:' + alternation + ')', 'g')
  const nameFieldAnyRe = new RegExp(
    'name\\s*:\\s*[\'"`](' + alternation + ')[\'"`]', 'g'
  )
  const registerAnyRe = new RegExp(
    'register\\s*\\(\\s*[\'"`](' + alternation + ')[\'"`]', 'g'
  )

  for (const plugin of plugins) {
    const rootDir = plugin.realDir || plugin.installedDir
    if (!rootDir) {
      warnings.push(`${plugin.id}：没有 realDir/installedDir，跳过`)
      continue
    }

    const files = collectFiles(rootDir, warnings, plugin.id)

    for (const file of files) {
      scannedFiles++
      let text
      try { text = readFileSync(file, 'utf8') } catch {
        continue
      }

      anyToolRe.lastIndex = 0
      const present = new Set()
      let m
      while ((m = anyToolRe.exec(text)) !== null) present.add(m[0])
      if (!present.size) continue

      const evidenceOf = new Map()

      nameFieldAnyRe.lastIndex = 0
      while ((m = nameFieldAnyRe.exec(text)) !== null) {
        if (!evidenceOf.has(m[1])) evidenceOf.set(m[1], 'name-field')
      }
      if (includeRegisterCall) {
        registerAnyRe.lastIndex = 0
        while ((m = registerAnyRe.exec(text)) !== null) {
          if (!evidenceOf.has(m[1])) evidenceOf.set(m[1], 'register-call')
        }
      }
      if (!evidenceOf.size) continue

      const rel = relative(rootDir, file) || basename(file)
      for (const [tool, evidence] of evidenceOf) {
        if (!names.includes(tool)) continue
        const existing = hits.get(tool)
        if (!existing || existing.has(plugin.id)) continue
        existing.set(plugin.id, `${evidence}:${rel}`)
      }
    }
  }

  for (const tool of names) {
    const map = hits.get(tool)
    const candidates = [...map.keys()].sort()
    if (!candidates.length) { unattributed.push(tool); continue }
    if (candidates.length === 1) {
      owners.push({ tool, pluginId: candidates[0], evidence: map.get(candidates[0]) })
      continue
    }
    ambiguous.push({ tool, candidates })
  }

  owners.sort((a, b) => a.tool.localeCompare(b.tool))
  ambiguous.sort((a, b) => a.tool.localeCompare(b.tool))
  unattributed.sort()

  return { owners, ambiguous, unattributed, scannedFiles, warnings }
}

export function calledToolNames(db) {
  if (!db || typeof db.prepare !== 'function') throw new Error('calledToolNames: 需要 openDb() 打开的库')
  const rows = db.prepare(
    "SELECT DISTINCT tool FROM events WHERE type = 'tool/call' AND tool IS NOT NULL AND tool <> '' ORDER BY tool"
  ).all()
  return rows.map((row) => row.tool)
}

export function declaredToolNames(db) {
  if (!db || typeof db.prepare !== 'function') throw new Error('declaredToolNames: 需要 openDb() 打开的库')
  let rows
  try {
    rows = db.prepare('SELECT DISTINCT name FROM declared_tools ORDER BY name').all()
  } catch {
    return []
  }
  return rows.map((row) => row.name)
}

export function attributeFromIndex(plugins, options = {}) {
  const warnings = []
  let db = null
  const names = new Set()
  try {
    db = openDb(options.root)
    for (const name of calledToolNames(db)) names.add(name)
    for (const name of declaredToolNames(db)) names.add(name)
  } catch (error) {
    warnings.push(`索引库读不到：${String(error.message).slice(0, 160)}`)
  } finally {
    if (db) { try { db.close() } catch {   } }
  }

  if (!names.size) {
    warnings.push('索引里没有任何工具名（先跑 atlas_scan）')
    return { owners: [], ambiguous: [], unattributed: [], scannedFiles: 0, warnings }
  }

  const result = attributeTools(plugins, [...names], { includeRegisterCall: options.includeRegisterCall })
  result.warnings.unshift(...warnings)
  return result
}
