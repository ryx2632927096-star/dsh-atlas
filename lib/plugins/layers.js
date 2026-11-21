import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { dshHome, currentProfile } from '../core/paths.js'

const MAX_READ_BYTES = 512 * 1024
const MAX_SCAN_BYTES = 2 * 1024 * 1024
const Q = '[\'"\\x60]'

function statSafe(p) {
  try { return statSync(p) } catch { return null }
}
function existsDir(p) {
  const s = statSafe(p)
  return !!s && s.isDirectory()
}
function existsFile(p) {
  const s = statSafe(p)
  return !!s && s.isFile()
}
function readText(p) {
  const s = statSafe(p)
  if (!s || !s.isFile() || s.size > MAX_READ_BYTES) return null
  try { return readFileSync(p, 'utf8') } catch { return null }
}
function readJson(p) {
  const t = readText(p)
  if (t === null) return null
  try { return JSON.parse(t) } catch { return null }
}

function listDirs(dir) {
  const out = []
  let names = []
  try { names = readdirSync(dir) } catch { return out }
  for (const name of names) {
    const p = join(dir, name)
    const s = statSafe(p)
    if (s && s.isDirectory()) out.push({ name, path: p })
  }
  return out
}

function listFiles(dir) {
  const out = []
  let names = []
  try { names = readdirSync(dir) } catch { return out }
  for (const name of names) {
    const p = join(dir, name)
    const s = statSafe(p)
    if (s && s.isFile()) out.push({ name, path: p, size: s.size })
  }
  return out
}

function sha16(p) {
  const s = statSafe(p)
  if (!s || !s.isFile() || s.size > MAX_READ_BYTES) return null
  try { return createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16) } catch { return null }
}

export function resolveMnemonHome(home) {
  const env = process.env.MNEMON_HOME
  if (env && env.trim() && existsDir(env.trim())) return { dir: env.trim(), source: 'env:MNEMON_HOME' }
  const sibling = join(dirname(home), '.mnemon')
  if (existsDir(sibling)) return { dir: sibling, source: 'sibling-of-dsh-home' }
  const under = join(home, '.mnemon')
  if (existsDir(under)) return { dir: under, source: 'under-dsh-home' }
  return { dir: sibling, source: 'absent' }
}

export function readEnabledPatchIds(home, profileName = currentProfile()) {
  const file = join(home, 'profiles', profileName, 'cordis.patch.yml')
  const text = readText(file)
  if (text === null) return { ids: new Set(), file, present: false }
  const ids = new Set()
  let current = null
  let disabled = false
  const flush = () => { if (current && !disabled) ids.add(current) }
  for (const line of text.split(/\r?\n/)) {
    const m = /^-\s+id:\s*(\S+)\s*$/.exec(line)
    if (m) {
      flush()
      current = m[1].replace(/^['"]|['"]$/g, '')
      disabled = false
      continue
    }
    if (current && /^-\s/.test(line)) { flush(); current = null; continue }
    if (current && /^\s{2}disabled:\s*true\s*$/.test(line)) disabled = true
  }
  flush()
  return { ids, file, present: true }
}


const TOOL_NAME_AFTER_DEF = new RegExp('(defineTool|tools\\.register|ToolDefinition)[\\s\\S]{0,240}?\\bname\\s*:\\s*' + Q + '([a-z][a-z0-9_]{1,60})' + Q, 'g')
const TOOL_NAME_BEFORE_FIELDS = new RegExp('\\bname\\s*:\\s*' + Q + '([a-z][a-z0-9_]{1,60})' + Q + '[\\s\\S]{0,240}?(?:execute|handler|parameters|inputSchema|output\\s*:)', 'g')
const LOOSE_NAME = new RegExp('\\bname\\s*:\\s*' + Q + '([a-z][a-z0-9_]{2,60})' + Q, 'g')

const NAME_STOPLIST = new Set([
  'main', 'index', 'default', 'string', 'number', 'boolean', 'object', 'array',
  'unknown', 'auto', 'tool', 'lead', 'model', 'read', 'write', 'pack', 'sync',
  'review', 'settings', 'view', 'activation', 'doctor', 'explain', 'gui', 'hook',
])

export function scanToolNames(pluginDir) {
  const names = new Set()
  const loose = new Set()
  let scannedFiles = 0

  const scanFile = (file) => {
    const s = statSafe(file)
    if (!s || !s.isFile() || s.size > MAX_SCAN_BYTES) return
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { return }
    scannedFiles++
    TOOL_NAME_AFTER_DEF.lastIndex = 0
    for (let m = TOOL_NAME_AFTER_DEF.exec(text); m; m = TOOL_NAME_AFTER_DEF.exec(text)) names.add(m[2])
    TOOL_NAME_BEFORE_FIELDS.lastIndex = 0
    for (let m = TOOL_NAME_BEFORE_FIELDS.exec(text); m; m = TOOL_NAME_BEFORE_FIELDS.exec(text)) names.add(m[1])
    LOOSE_NAME.lastIndex = 0
    for (let m = LOOSE_NAME.exec(text); m; m = LOOSE_NAME.exec(text)) loose.add(m[1])
  }

  const scanDirShallow = (dir) => {
    for (const f of listFiles(dir)) {
      if (f.name.endsWith('.map')) continue
      if (!f.name.endsWith('.js') && !f.name.endsWith('.mjs')) continue
      scanFile(f.path)
    }
  }

  for (const sub of ['lib', 'dist']) {
    const dir = join(pluginDir, sub)
    if (existsDir(dir)) scanDirShallow(dir)
  }
  scanDirShallow(pluginDir)
  for (const sub of listDirs(pluginDir)) {
    if (sub.name === 'node_modules' || sub.name === '.bin' || sub.name.startsWith('.')) continue
    scanDirShallow(sub.path)
  }

  const keep = [...names].filter((n) => !NAME_STOPLIST.has(n))
  const keepLoose = [...loose].filter((n) => !NAME_STOPLIST.has(n) && !names.has(n))
  return { names: keep.sort(), loose: keepLoose.sort(), scannedFiles }
}

const TOOL_DOMAINS = [
  { cap: 'tool.desktop-control', why: '桌面控制', re: /(desktop[\s-]+control|desktop[\s-]+automation|ui automation|native desktop|screen_shot|screen_read|clipboard)/i },
  { cap: 'tool.browser', why: '浏览器控制', re: /browser_/i },
  { cap: 'tool.memory', why: '记忆读写', re: /(mnemon|mnemon_recall|memory[\s-]+spaces)/i },
  { cap: 'tool.task-board', why: '任务看板', re: /task_board|task[\s-]+board/i },
  { cap: 'tool.ssh', why: '远程执行', re: /ssh_/i },
  { cap: 'tool.mcp-bridge', why: 'MCP 桥接', re: /ws_mcp|mcp[\s-]+(server|client|manager)/i },
  { cap: 'tool.skills', why: '技能管理', re: /skill[\s-]+(management|center|explorer|library)/i },
]

export function classifyToolDomain(description, toolNames) {
  const hay = [String(description || ''), (toolNames || []).join(' ')].join(' ')
  for (const d of TOOL_DOMAINS) {
    const m = d.re.exec(hay)
    if (m) return { cap: d.cap, why: d.why + '（命中词：' + m[0] + '）' }
  }
  return null
}


export function collectLayers(options = {}) {
  const home = options.home || dshHome()
  const profileName = options.profileName || currentProfile()
  const items = []
  const warnings = []
  const seen = new Set()

  const push = (item) => {
    const key = item.layer + '::' + item.backendId
    if (seen.has(key)) return
    seen.add(key)
    items.push(item)
  }

  const mnemon = resolveMnemonHome(home)
  const patch = readEnabledPatchIds(home, profileName)
  if (!patch.present) warnings.push('读不到 profile 的 cordis.patch.yml，条目启用状态降级为「只要目录存在就算启用」')
  const isEnabled = (id) => (patch.present ? patch.ids.has(id) : true)

  if (mnemon.source === 'absent') {
    warnings.push('找不到 ~/.mnemon（记忆层可能整块缺失），已按 home 推导为 ' + mnemon.dir)
  } else {
    const runtimeDir = join(mnemon.dir, 'runtime')
    if (existsDir(runtimeDir)) {
      const memJson = readJson(join(runtimeDir, 'memories.json'))
      const entryCount = Array.isArray(memJson?.entries) ? memJson.entries.length : 0
      const memBytes = (statSafe(join(runtimeDir, 'MEMORY.md'))?.size) ?? 0
      const userBytes = (statSafe(join(runtimeDir, 'USER.md'))?.size) ?? 0
      push({
        layer: 'memory',
        backendId: 'mnemon-runtime',
        pluginId: 'dsh-mnemon-source-runtime',
        storePath: runtimeDir,
        readApi: 'mnemon_runtime_memory',
        writeApi: 'mnemon_runtime_memory',
        scope: 'agent',
        active: isEnabled('mnemon-source-runtime'),
        detail: 'MEMORY.md ' + memBytes + 'B / USER.md ' + userBytes + 'B / memories.json ' + entryCount + ' 条；来源 ' + mnemon.source,
        facts: { entryCount, memBytes, userBytes, mnemonSource: mnemon.source, memoriesJson: memJson },
      })
    }

    const dataDir = join(mnemon.dir, 'data')
    if (existsDir(dataDir)) {
      const bodies = readJson(join(dataDir, '.dsh-memory-bodies.json'))
      const list = Array.isArray(bodies?.bodies) ? bodies.bodies : []
      const activeBodies = list.filter((b) => b && b.active)
      let activeFile = null
      try { activeFile = readFileSync(join(mnemon.dir, 'active'), 'utf8').trim() } catch { activeFile = null }
      push({
        layer: 'memory',
        backendId: 'mnemon-memory-spaces',
        pluginId: 'dsh-mnemon-source-memory-spaces',
        storePath: dataDir,
        readApi: 'mnemon_recall',
        writeApi: 'mnemon_remember',
        scope: 'agent',
        active: isEnabled('mnemon-source-memory-spaces'),
        detail: list.length + ' 个记忆空间，激活 ' + activeBodies.length
          + (activeFile ? '（active=' + activeFile.slice(0, 8) + '…）' : ''),
        facts: { bodyCount: list.length, activeBodies: activeBodies.length, bodyDescriptions: activeBodies.map((b) => String(b.description || '')) },
      })
    }

    const docsDir = join(mnemon.dir, 'documents')
    if (existsDir(docsDir)) {
      const index = readJson(join(docsDir, 'index.json'))
      const docs = Array.isArray(index?.documents) ? index.documents : []
      push({
        layer: 'memory',
        backendId: 'mnemon-documents',
        pluginId: 'dsh-mnemon-source-documents',
        storePath: docsDir,
        readApi: 'mnemon_document_search',
        writeApi: 'mnemon_document_create',
        scope: 'agent',
        active: isEnabled('mnemon-source-documents'),
        detail: docs.length + ' 篇项目文档（active ' + listFiles(join(docsDir, 'active')).length
          + ' / archived ' + listFiles(join(docsDir, 'archived')).length + '）',
        facts: { documentCount: docs.length },
      })
    }

    const skillsDir = join(mnemon.dir, 'skills')
    if (existsDir(skillsDir)) {
      const trajCount = listFiles(join(skillsDir, 'trajectories')).length
      push({
        layer: 'memory',
        backendId: 'mnemon-skills',
        pluginId: 'dsh-mnemon-source-skills',
        storePath: skillsDir,
        readApi: 'skill',
        writeApi: null,
        scope: 'agent',
        active: isEnabled('mnemon-source-skills'),
        detail: 'trajectories ' + trajCount + ' 条 / market ' + listFiles(join(skillsDir, 'market')).length + ' 个',
        facts: { trajectoryCount: trajCount },
      })
    }
  }

  const charRoot = join(home, 'surfcore', 'characters')
  const current = readJson(join(charRoot, 'current.json'))
  const indexAll = readJson(join(charRoot, 'index.json'))
  const charDirs = listDirs(charRoot).filter((d) => d.name.startsWith('char-'))
  if (!charDirs.length && existsDir(join(home, 'surfcore'))) {
    warnings.push('surfcore 存在但 characters/ 下没有 char-* 目录，角色层可能只有模板')
  }
  for (const c of charDirs) {
    const cid = c.name
    const isCurrent = current?.id === cid
    const memDir = join(c.path, 'memory')
    if (existsDir(memDir)) {
      const files = listFiles(memDir)
      push({
        layer: 'memory',
        backendId: 'surfcore-memory:' + cid,
        pluginId: 'surfcore',
        storePath: memDir,
        readApi: 'surfcore:memory-card',
        writeApi: 'surfcore:memory-card',
        scope: 'character',
        active: isCurrent && isEnabled('surfcore'),
        detail: files.length + ' 个文件（' + files.slice(0, 4).map((f) => f.name).join(' / ')
          + (files.length > 4 ? ' …' : '') + '）' + (isCurrent ? '，当前角色' : '，非当前角色'),
        facts: { fileCount: files.length, characterId: cid, characterName: current?.name || null },
      })
    }
  }

  for (const c of charDirs) {
    const cid = c.name
    const isCurrent = current?.id === cid
    const entry = Array.isArray(indexAll?.characters) ? indexAll.characters.find((x) => x.id === cid) : null
    const declaredPersona = entry && typeof entry.persona === 'string' && entry.persona ? entry.persona : 'persona.md'

    for (const file of ['persona.md', 'persona.full.md']) {
      const p = join(c.path, file)
      const s = statSafe(p)
      if (!s || !s.isFile()) continue
      const isDeclared = file === declaredPersona
      push({
        layer: 'persona',
        backendId: 'surfcore-persona' + (file === 'persona.md' ? '' : '-full') + ':' + cid,
        pluginId: 'surfcore',
        storePath: p,
        readApi: 'surfcore:persona',
        writeApi: 'surfcore:persona',
        scope: 'character',
        active: isCurrent && isDeclared && isEnabled('surfcore'),
        detail: s.size + 'B'
          + (isDeclared ? '，index.json 声明为生效人格' : '，index.json 未声明它（' + declaredPersona + ' 才是声明项）'),
        facts: { bytes: s.size, contentHash: sha16(p), characterId: cid, declared: isDeclared },
      })
    }
  }

  const agentsMd = join(home, 'AGENTS.md')
  if (existsFile(agentsMd)) {
    const s = statSafe(agentsMd)
    push({
      layer: 'persona',
      backendId: 'dsh-agents-md',
      pluginId: null,
      storePath: agentsMd,
      readApi: 'session:system-prompt',
      writeApi: null,
      scope: 'agent',
      active: true,
      detail: s.size + 'B，宿主级协作规则，注入每个会话',
      facts: { bytes: s.size, contentHash: sha16(agentsMd) },
    })
  }

  const presetLedger = join(home, 'dsh-agents', 'ledger.json')
  if (existsFile(presetLedger)) {
    const s = statSafe(presetLedger)
    const ledger = readJson(presetLedger)
    const count = Array.isArray(ledger?.presets) ? ledger.presets.length
      : (ledger && typeof ledger === 'object' ? Object.keys(ledger).length : 0)
    push({
      layer: 'persona',
      backendId: 'dsh-agents-presets',
      pluginId: '@linxin666/dsh-agents',
      storePath: presetLedger,
      readApi: 'squads_read',
      writeApi: null,
      scope: 'agent',
      active: count > 0,
      detail: s.size + 'B，台账条目 ' + count + ' 个',
      facts: { bytes: s.size, presetCount: count },
    })
  }

  const personaTemplate = join(home, 'plugins', 'surfcore', 'persona')
  if (existsDir(personaTemplate)) {
    const files = listFiles(personaTemplate)
    push({
      layer: 'persona',
      backendId: 'surfcore-persona-template',
      pluginId: 'surfcore',
      storePath: personaTemplate,
      readApi: null,
      writeApi: null,
      scope: 'character',
      active: false,
      detail: files.length + ' 个文件，随插件分发的模板，需被角色目录实例化后才生效'
        + '（index.json 指向角色目录，不指向这里）',
      facts: { fileCount: files.length },
    })
  }

  const packages = options.plugins && options.plugins.length
    ? options.plugins.map((p) => ({
      name: p.id || p.name,
      dir: p.realDir || p.installedDir || p.dir,
      description: p.description || '',
      dsh: p.hasDshField,
    }))
    : discoverPackages(home, profileName, warnings)

  const installedRoot = join(home, 'profiles', profileName, 'node_modules')
  for (const pkg of packages) {
    if (!pkg || !pkg.dir || !existsDir(pkg.dir)) continue
    const isDsh = pkg.dsh || /(^|\/)dsh[-_]/.test(pkg.name || '') || /dsh|surfcore/i.test(pkg.name || '')
    if (!isDsh) continue
    const scan = scanToolNames(pkg.dir)
    if (!scan.names.length) {
      if (scan.loose.length) {
        warnings.push('工具层跳过 ' + pkg.name + '：扫到疑似字段名 ' + scan.loose.slice(0, 5).join(', ')
          + '，但没对上 defineTool/tools.register 定义式，不当成工具名')
      }
      continue
    }
    const domain = classifyToolDomain(pkg.description, scan.names)
    const parts = []
    parts.push(scan.names.length + ' 个工具：' + scan.names.slice(0, 6).join(', ')
      + (scan.names.length > 6 ? ' …' : ''))
    if (domain) parts.push(domain.why)
    push({
      layer: 'tool',
      backendId: pkg.name,
      pluginId: pkg.name,
      storePath: pkg.dir,
      readApi: scan.names.length ? scan.names[0] : null,
      writeApi: null,
      scope: 'agent',
      active: existsDir(join(installedRoot, pkg.name)),
      detail: parts.join('；'),
      facts: {
        toolNames: scan.names,
        toolCount: scan.names.length,
        domain: domain ? domain.cap : null,
        scannedFiles: scan.scannedFiles,
      },
    })
  }

  return { items, warnings }
}

function discoverPackages(home, profileName, warnings) {
  const nm = join(home, 'profiles', profileName, 'node_modules')
  if (!existsDir(nm)) {
    warnings.push('找不到 profile 的 node_modules：' + nm + '，工具层会是空的')
    return []
  }
  const out = []
  for (const t of listDirs(nm)) {
    if (t.name === '.bin' || t.name === '.pnpm' || t.name.startsWith('.')) continue
    const candidates = t.name.startsWith('@')
      ? listDirs(t.path).map((s) => ({ name: t.name + '/' + s.name, path: s.path }))
      : [t]
    for (const c of candidates) {
      if (c.name === 'node_modules' || c.name.endsWith('/node_modules')) continue
      const pkgJson = readJson(join(c.path, 'package.json'))
      if (!pkgJson) continue
      out.push({
        name: typeof pkgJson.name === 'string' ? pkgJson.name : c.name,
        dir: c.path,
        description: typeof pkgJson.description === 'string' ? pkgJson.description : '',
        dsh: !!pkgJson.dsh,
      })
    }
  }
  return out
}


const W = {
  samePhysical: 0.55,
  containment: 0.28,
  sameApi: 0.26,
  sameFamily: 0.20,
  sameCapability: 0.20,
  nameOverlap: 0.16,
  sameScope: 0.12,
  bothActive: 0.08,
  differentScope: 0.20,
  inactiveSide: -0.10,
}

export function capabilityOf(item) {
  const id = String(item.backendId || '')
  if (item.layer === 'memory') {
    if (/runtime/i.test(id)) return 'memory.hot'
    if (/memory-spaces/i.test(id)) return 'memory.durable-recall'
    if (/documents/i.test(id)) return 'memory.documents'
    if (/skills/i.test(id)) return 'memory.skills'
    if (/^surfcore-memory/.test(id)) return 'memory.character'
    return 'memory.unclassified'
  }
  if (item.layer === 'persona') {
    if (/persona-template/.test(id)) return 'persona.template'
    if (/persona-full|surfcore-persona/.test(id)) return 'persona.core'
    if (/agents-md/.test(id)) return 'persona.agent-rules'
    if (/agents-presets/.test(id)) return 'persona.preset-library'
    return 'persona.unclassified'
  }
  const domain = item.facts && item.facts.domain
  return domain || 'tool.unclassified'
}

function tokensOf(item) {
  const set = new Set()
  for (const t of String(item.backendId || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (t && t.length > 2) set.add(t)
  }
  return set
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

function familyOf(item) {
  const p = String(item.pluginId || '')
  if (!p) return ''
  const m = /^(dsh-mnemon)-/.exec(p)
  if (m) return m[1]
  if (!p.startsWith('@')) return /^dsh-/.test(p) ? p.replace(/-(provider|source|strategy)-.*$/, '') : ''
  return ''
}

function isUnder(child, parent) {
  if (!child || !parent) return false
  const c = String(child).replace(/[\\/]+$/, '').toLowerCase()
  const p = String(parent).replace(/[\\/]+$/, '').toLowerCase()
  if (c === p) return false
  return c.startsWith(p + '/') || c.startsWith(p + '\\')
}

export function findOverlaps(items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : []
  const out = []
  const tokenCache = new Map()
  const tokensFor = (it) => {
    if (!tokenCache.has(it)) tokenCache.set(it, tokensOf(it))
    return tokenCache.get(it)
  }

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]
      const b = list[j]
      if (a.layer !== b.layer) continue

      const evidence = []
      let score = 0

      const hashA = a.facts && a.facts.contentHash
      const hashB = b.facts && b.facts.contentHash
      const samePath = !!a.storePath && !!b.storePath
        && String(a.storePath).toLowerCase() === String(b.storePath).toLowerCase()
      const samePhysical = samePath || (!!hashA && hashA === hashB)
      if (samePhysical) {
        score += W.samePhysical
        evidence.push(samePath
          ? 'storePath 完全相同：' + a.storePath
          : '内容指纹相同（sha256:' + hashA + '）：' + a.storePath + ' ↔ ' + b.storePath)
      }

      if (!samePhysical && (isUnder(a.storePath, b.storePath) || isUnder(b.storePath, a.storePath))) {
        score += W.containment
        const inner = isUnder(a.storePath, b.storePath) ? a : b
        const outer = inner === a ? b : a
        evidence.push('存储路径嵌套：' + inner.storePath + ' 落在 ' + outer.storePath + ' 之内')
      }

      const apiA = [a.readApi, a.writeApi].filter(Boolean)
      const apiB = [b.readApi, b.writeApi].filter(Boolean)
      const sharedApi = apiA.filter((x) => apiB.includes(x))
      if (sharedApi.length) {
        score += W.sameApi
        evidence.push('共用 API：' + sharedApi.join(', '))
      }

      const famA = familyOf(a)
      const famB = familyOf(b)
      if (famA && famA === famB) {
        score += W.sameFamily
        evidence.push('同一插件家族：' + famA)
      }

      const capA = capabilityOf(a)
      const capB = capabilityOf(b)
      const sameCapability = capA === capB && !/unclassified$/.test(capA)
      if (sameCapability) {
        score += W.sameCapability
        evidence.push('能力槽位相同：' + capA)
      }


      const jac = jaccard(tokensFor(a), tokensFor(b))
      if (jac > 0) {
        score += W.nameOverlap * jac
        evidence.push('backendId 词元相似度 ' + jac.toFixed(2) + '（' + a.backendId + ' ↔ ' + b.backendId + '）')
      }

      if (a.scope === b.scope) {
        score += W.sameScope
        evidence.push('作用域相同：' + a.scope)
      } else {
        score += W.differentScope
        evidence.push('作用域不同：' + a.scope + ' ↔ ' + b.scope + '（结构上分区，各自管一段，不存在二选一的必要）')
      }
      if (a.active && b.active) {
        score += W.bothActive
      } else {
        score += W.inactiveSide
        const off = [a, b].filter((x) => !x.active).map((x) => x.backendId)
        evidence.push('未启用的一方：' + off.join(', ') + '，无法从运行时状态取证')
      }

      score = Math.max(0, Math.min(1, score))

      const toolsA = (a.facts && a.facts.toolNames) || null
      const toolsB = (b.facts && b.facts.toolNames) || null
      const missingSide = a.layer === 'tool'
        && ((!toolsA || !toolsA.length) || (!toolsB || !toolsB.length))
      if (missingSide) evidence.push('静态扫描拿不到一方的工具名，无法判断是否注册了同名工具')

      let kind
      if (samePhysical) {
        kind = 'duplicate'
      } else if (a.layer === 'tool') {
        const inter = (toolsA || []).filter((n) => (toolsB || []).includes(n))
        if (inter.length) {
          kind = 'duplicate'
          evidence.push('注册了同名工具：' + inter.join(', '))
        } else if (sameCapability) {
          kind = 'complement'
          evidence.push('同属工具能力域 ' + capA + '，但注册的工具名不重合')
        } else {
          continue
        }
      } else if (sameCapability && a.scope === b.scope) {
        kind = 'conflict'
      } else {
        kind = 'complement'
      }

      let verdict
      if (kind === 'duplicate' || kind === 'conflict') {
        verdict = score >= 0.65 ? 'keep-one' : 'unverified'
      } else {
        verdict = missingSide ? 'unverified' : (score >= 0.28 ? 'coexist' : 'unverified')
      }

      if (score < 0.28) continue

      out.push({
        layer: a.layer,
        a: a.backendId,
        b: b.backendId,
        kind,
        verdict,
        score: Number(score.toFixed(3)),
        evidence,
      })
    }
  }

  out.sort((x, y) => y.score - x.score
    || (x.layer + '|' + x.a + '|' + x.b).localeCompare(y.layer + '|' + y.a + '|' + y.b))
  return out
}

export const VERDICTS = Object.freeze(['coexist', 'keep-one', 'unverified'])
export const KINDS = Object.freeze(['duplicate', 'complement', 'conflict'])
export const LAYERS = Object.freeze(['memory', 'persona', 'tool'])
