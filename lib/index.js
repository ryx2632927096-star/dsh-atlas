import { appendFileSync, mkdirSync, existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { scan, summary, openDb } from './observe/scan.js'
import { atlasRoot, checkNodeVersion, dshHome, currentProfile, profileDir } from './core/paths.js'
import { loadDependencies, updatePlugins, renderUpdateReport } from './update/update.js'
import { resolveLlm, askModel, askJson, routeFor, listSlots, DEFAULT_TIMEOUT_MS } from './ai/llm.js'
import { aiReviewOverlaps } from './ai/ai-overlap.js'
import { fileURLToPath } from 'node:url'
import { dirname as pathDirname, join as pathJoin } from 'node:path'

const PACKAGE_ROOT = pathDirname(pathDirname(fileURLToPath(import.meta.url)))
const RESCUE_PATH = pathJoin(PACKAGE_ROOT, 'rescue.mjs')
import { resolveDefineTool, compatState, textOutputSchema } from './core/compat.js'
import { buildToolCard, listTools, renderToolCard, renderToolList } from './observe/toolcard.js'
import { buildPitfalls, renderPitfalls } from './observe/pitfalls.js'
import { buildGraph, findChains, findAntiPatterns, renderGraph, renderMcpRecipe } from './observe/graph.js'
import { checkAllPatches, applyPatch, hardlinkCount } from './patches/patches.js'
import { createSnapshot, listSnapshots, diffSnapshot } from './patches/snapshot.js'
import { checkAllUpstream, renderUpstreamReport, inventoryPlugins, npmLatest, compareVersions } from './upstream/upstream.js'
import { analyzeSurface, renderSurface } from './observe/surface.js'
import { recordLedger, readLedger, ledgerSummary, renderLedger, ledgerPath } from './patches/ledger.js'
import { scanLocalModifications, diffAgainstRegistry, generatePatchRecord } from './patches/drift.js'
import { runPatrol, renderPatrol, patrolDueInfo, readPatrolState } from './upstream/patrol.js'
import { readProfileState, buildRemediationPlan, renderRemediation } from './plugins/remediate.js'
import { collectLayers, findOverlaps } from './plugins/layers.js'
import { registerRoutes } from './ui/api.js'
import { resolveModels, describeModels, modelArgs, MODEL_SLOTS } from './ai/models.js'
import { writeModelSlot } from './core/config-write.js'
import { verifyPluginChange } from './verify/verify-plugin.js'
import { auditPatchesOnBoot } from './patches/patch-audit.js'
import { dryRun } from './verify/dryrun.js'
import { listSkills, skillUsage, analyzeSkills, renderSkills } from './observe/skills.js'
import { discoverPlugins, pluginForPath } from './plugins/plugins.js'
import { attributeTools, calledToolNames, declaredToolNames } from './plugins/attribution.js'

export const name = 'dsh-atlas'
export const inject = ['tools', 'webServer']
function trace(root, event, detail) {
  try {
    mkdirSync(root, { recursive: true })
    appendFileSync(
      join(root, 'load-trace.log'),
      `${new Date().toISOString()}\t${event}\t${detail || ''}\n`,
      'utf8'
    )
  } catch {   }
}

function earlyTrace(event, detail) {
  try {
    const base = process.env.DSH_ATLAS_HOME
      || (process.env.DSH_HOME && join(process.env.DSH_HOME, 'dsh-atlas'))
      || join(homedir(), '.dsh', 'dsh-atlas')
    mkdirSync(base, { recursive: true })
    appendFileSync(join(base, 'load-trace.log'), `${new Date().toISOString()}\t${event}\t${detail || ''}\n`, 'utf8')
  } catch {   }
}

earlyTrace('module-start', `pid=${process.pid}`)

function sourceTypeOf(dir, name) {
  if (!dir) return 'unknown'
  try {
    if (lstatSync(dir).isSymbolicLink()) {
      try {
        const pkg = JSON.parse(readFileSync(join(profileDir(), 'package.json'), 'utf8'))
        const spec = String(pkg?.dependencies?.[name] || '')
        if (spec.startsWith('link:')) return 'link-source'
      } catch {   }
      return 'link-junction'
    }
  } catch {   }
  return 'npm'
}

function pluginIdFromTarget(target) {
  if (typeof target !== 'string' || !target) return null
  if (target.startsWith('profile:')) {
    const rest = target.slice('profile:'.length)
    const parts = rest.split('/')
    if (parts[0] === '@' && parts.length > 2) return parts.slice(0, 2).join('/')
    if (parts[0]?.startsWith('@')) return parts.slice(0, 2).join('/')
    return parts[0] || null
  }
  if (target.startsWith('surfcore:') || target.startsWith('surfcore-plugin:')) return 'surfcore'
  if (target.startsWith('snowluma:')) return 'snowluma'
  return null
}

function textResult() {
  return {
    schema: textOutputSchema(),
    render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
  }
}

export function apply(ctx, config = {}) {
  const root = config.root || atlasRoot()

  const models = resolveModels(config)
  for (const w of models.warnings) trace(root, 'models-warning', w)
  trace(root, 'models-resolved',
    Object.entries(models.slots).map(([k, v]) => k + '=' + (v.followsDefault ? 'default' : (v.provider || '') + '/' + v.model)).join(' '))

  const nodeProblem = checkNodeVersion()
  if (nodeProblem) {
    trace(root, 'node-version-rejected', nodeProblem)
    try { console.error('[dsh-atlas] ' + nodeProblem) } catch {   }
    return
  }

  trace(root, 'apply-called', `tools=${typeof ctx?.tools}; node=${process.versions.node}`)

  try {
    const audit = auditPatchesOnBoot(root, { write: (k, v) => trace(root, k, v) })
    if (!audit.ok && audit.message) {
      try { console.error('[dsh-atlas] ⚠ ' + audit.message) } catch {   }
    }
  } catch {   }

  if (!ctx?.tools || typeof ctx.tools.register !== 'function') {
    const text = '[dsh-atlas] ctx.tools 不可用，工具未注册（inject 未满足）'
    trace(root, 'apply-failed', text)
    try { console.error(text) } catch {   }
    return
  }

  const start = (defineTool) => {
    trace(root, 'define-tool-resolved', `via=${compatState()}`)

  const safeRegister = (label, factory) => {
    try {
      ctx.tools.register(factory())
      trace(root, 'tool-registered', label)
      return true
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      trace(root, 'tool-register-failed', `${label}: ${detail}`)
      try { console.error(`[dsh-atlas] 注册 ${label} 失败：${detail}`) } catch {   }
      return false
    }
  }

  safeRegister('atlas_scan', () => defineTool({
    name: 'atlas_scan',
    description: '扫描并索引所有 DSH 会话记录（默认增量，只处理变化过的文件）。' +
      '数据只落本地 SQLite，不联网、不外发。首次全量约 2 秒，增量通常 <200ms。',
    parameters: {
      full: { type: 'boolean', description: '可选。true = 忽略水位全量重扫' },
    },
    output: textResult(),
    async execute(args) {
      const result = scan({ root, full: args?.full === true })
      const lines = [
        `扫描完成（${result.elapsedMs}ms）`,
        `文件 ${result.files}｜扫描 ${result.scanned}｜跳过 ${result.skipped}｜失败 ${result.failed}｜不支持 ${result.unsupported}`,
        `入库事件 ${result.events}｜工具调用 ${result.toolCalls}｜错误 ${result.errors}｜未回连 ${result.unresolvedResults}`,
        `真人发言 ${result.humanMessages}｜系统注入 ${result.injectedMessages}`,
      ]
      if (result.failures.length) {
        lines.push('失败：')
        for (const f of result.failures.slice(0, 5)) lines.push(`- ${f.file}：${f.reason}`)
      }
      return { text: lines.join('\n') }
    },
  }))

  safeRegister('atlas_summary', () => defineTool({
    name: 'atlas_summary',
    description: '读取会话索引总览：会话数、事件数、工具调用与报错、真人发言与注入的区分，以及 Top 20 工具统计。',
    parameters: {},
    output: textResult(),
    async execute() {
      const { totals, topTools } = summary(root)
      const lines = [
        '=== 索引总览 ===',
        `会话 ${totals.sessions}｜事件 ${totals.events}｜工具调用 ${totals.tool_calls}｜工具结果 ${totals.tool_results}`,
        `错误 ${totals.errors}｜不同工具 ${totals.distinct_tools}`,
        `真人发言 ${totals.human_messages}｜系统注入 ${totals.injected_messages}`,
        '',
        '=== Top 工具（调用数 / 报错数）===',
      ]
      for (const row of topTools) {
        lines.push(`${String(row.calls).padStart(6)}  ${row.tool}  错误 ${row.errors}`)
      }
      return { text: lines.join('\n') }
    },
  }))

  safeRegister('atlas_errors', () => defineTool({
    name: 'atlas_errors',
    description: '列出工具报错记录，可按工具名过滤。用于复盘「哪个工具踩过什么坑」。',
    parameters: {
      tool: { type: 'string', description: '可选。工具名，如 ws_mcp_call；留空列出全部' },
      limit: { type: 'number', description: '可选。返回条数，默认 20，最大 100' },
    },
    output: textResult(),
    async execute(args) {
      const toolName = typeof args?.tool === 'string' ? args.tool.trim() : ''
      const raw = Number(args?.limit)
      const limit = Number.isFinite(raw) ? Math.max(1, Math.min(100, Math.floor(raw))) : 20
      const db = openDb(root)
      try {
        const rows = toolName
          ? db.prepare(
              "SELECT session_id, seq, tool, summary FROM events WHERE type='tool/result' AND is_error=1 AND tool=? ORDER BY time DESC LIMIT ?"
            ).all(toolName, limit)
          : db.prepare(
              "SELECT session_id, seq, tool, summary FROM events WHERE type='tool/result' AND is_error=1 ORDER BY time DESC LIMIT ?"
            ).all(limit)
        if (!rows.length) return { text: toolName ? `工具 ${toolName} 没有报错记录。` : '没有报错记录。' }
        const lines = [`报错记录 ${rows.length} 条${toolName ? `（工具 ${toolName}）` : ''}：`, '']
        for (const row of rows) {
          lines.push(`[${row.tool || '未知工具'}] ${String(row.summary || '').replace(/\s+/g, ' ').slice(0, 180)}`)
        }
        return { text: lines.join('\n') }
      } finally {
        try { db.close() } catch {   }
      }
    },
  }))

  safeRegister('atlas_tool', () => defineTool({
    name: 'atlas_tool',
    description: '查询某个工具的用法画像：调用次数、成功率、踩过哪些坑、常搭配哪些工具一起用。' +
      '不给工具名则返回使用排行。数据来自真实的工具调用记录。',
    parameters: {
      name: { type: 'string', description: '可选。工具名，如 ws_mcp_call；留空则列出使用排行' },
    },
    output: textResult(),
    async execute(args) {
      const name_ = typeof args?.name === 'string' ? args.name.trim() : ''
      const db = openDb(root)
      try {
        if (!name_) return { text: renderToolList(listTools(db, 40)) }
        const card = buildToolCard(db, name_)
        if (!card) return { text: `没有找到工具 ${name_} 的调用记录。用空参数调用可看排行。` }
        return { text: renderToolCard(card) }
      } finally {
        try { db.close() } catch {   }
      }
    },
  }))

  safeRegister('atlas_pitfalls', () => defineTool({
    name: 'atlas_pitfalls',
    description: '踩坑库：把历史报错归因成「现象→根因→正确做法→怎么验证」。' +
      '可按严重程度过滤（high/medium/low/info）。',
    parameters: {
      severity: { type: 'string', description: '可选。只看某级别：high / medium / low / info' },
      limit: { type: 'number', description: '可选。返回条数，默认 20' },
    },
    output: textResult(),
    async execute(args) {
      const severity = typeof args?.severity === 'string' ? args.severity.trim().toLowerCase() : ''
      const raw = Number(args?.limit)
      const limit = Number.isFinite(raw) ? Math.max(1, Math.min(50, Math.floor(raw))) : 20
      const db = openDb(root)
      try {
        const report = buildPitfalls(db)
        return { text: renderPitfalls(report, { severity: severity || null, limit }) }
      } finally {
        try { db.close() } catch {   }
      }
    },
  }))

  safeRegister('atlas_graph', () => defineTool({
    name: 'atlas_graph',
    description: '工具协同图谱：哪些工具该一起用、按什么顺序、哪条链路成功率高、哪些组合是反模式。' +
      'includes=recipe 时额外给出 MCP 工具的标准调用套路。',
    parameters: {
      includes: { type: 'string', description: '可选。填 recipe 则附带 MCP 调用套路说明' },
    },
    output: textResult(),
    async execute(args) {
      const includes = typeof args?.includes === 'string' ? args.includes.trim() : ''
      const db = openDb(root)
      try {
        const graph = buildGraph(db)
        const parts = [
          renderGraph(graph, {
            chains: findChains(graph),
            antiPatterns: findAntiPatterns(graph),
          }),
        ]
        if (includes === 'recipe') {
          parts.push('', renderMcpRecipe(db))
        }
        return { text: parts.join('\n') }
      } finally {
        try { db.close() } catch {   }
      }
    },
  }))

  safeRegister('atlas_model_check', () => defineTool({
    name: 'atlas_model_check',
    description: '真的调一次模型，验证「配置 → 路由 → 调用」整条链路通不通。' +
      '不带参数 = 用默认槽位试一句；带 slot 指定用途；带 prompt 自定义问题。' +
      '只发这一句提示，不发任何本机内容。',
    parameters: {
      slot: { type: 'string', description: '可选。用途槽位：overlap（判重）/ upstreamFix（判上游是否已修复）/ delegate（派活）' },
      prompt: { type: 'string', description: '可选。自定义提问；留空用内置的一句' },
      timeoutMs: { type: 'number', description: '可选。超时毫秒，默认 45000' },
    },
    output: textResult(),
    async execute(args) {
      const slot = typeof args?.slot === 'string' && args.slot.trim() ? args.slot.trim() : 'overlap'
      const known = listSlots().map((s) => s.key)
      if (!known.includes(slot)) {
        return { text: '没有「' + slot + '」这个用途。可选：' + known.join(' / ') }
      }

      const llm = llmService || resolveLlm(ctx)
      const lines = []
      lines.push('=== 模型链路自检 ===')
      lines.push('本次用途：' + slot)
      lines.push('llm 服务：' + (llm ? '已就绪' : '不可用'))
      if (!llm) {
        lines.push('')
        lines.push('原因可能是：① 宿主版本太老没注入 llm 服务')
        lines.push('             ② 这个 profile 没配任何模型')
        lines.push('依赖模型的工具会全部不可用，纯规则的工具不受影响。')
        return { text: lines.join('\n') }
      }

      let route
      try { route = routeFor(models, slot, defaultModelContext) }
      catch (error) { return { text: lines.concat('', error.message).join('\n') } }
      lines.push('路由：' + route.provider + ' / ' + route.model
        + (route.followsDefault ? '（跟随 DSH 当前默认）' : '（按槽位指定）')
        + (route.reasoningEffort ? '；推理强度：' + route.reasoningEffort : ''))
      lines.push('')

      const prompt = typeof args?.prompt === 'string' && args.prompt.trim()
        ? args.prompt.trim()
        : '用一句话回答：你现在能正常工作吗？'
      const t0 = Date.now()
      const r = await askModel(llm, route, {
        prompt,
        timeoutMs: Number.isFinite(args?.timeoutMs) ? args.timeoutMs : DEFAULT_TIMEOUT_MS,
      })
      const ms = Date.now() - t0

      if (!r.ok) {
        lines.push('❌ 调用失败（' + ms + 'ms）：' + r.error)
        return { text: lines.join('\n') }
      }
      lines.push('✅ 调用成功（' + ms + 'ms）')
      lines.push('')
      lines.push('模型回复：')
      lines.push(r.text.split('\n').map((l) => '  ' + l).join('\n'))
      return { text: lines.join('\n') }
    },
  }))

  safeRegister('atlas_update', () => defineTool({
    name: 'atlas_update',
    description: '更新 npm 安装的插件（link 装的会跳过并说明）。' +
      'action=list 只看哪些能更新；action=plan 预演；action=run 真更新（先备份，失败自动回滚）。' +
      '更新完会立刻复查补丁，掉了会报出来。',
    parameters: {
      action: { type: 'string', description: '可选。list（默认）/ plan / run' },
      packages: { type: 'string', description: '可选。逗号分隔的包名；留空 = 全部可更新的' },
      dryRun: { type: 'boolean', description: '可选。true 时只预演（run 的默认行为也是预演）' },
    },
    output: textResult(),
    async execute(args) {
      const action = typeof args?.action === 'string' ? args.action.trim().toLowerCase() : 'list'
      const deps = loadDependencies()
      if (!deps.ok) return { text: '读不到 profile 依赖：' + deps.error }

      const parseNames = () => {
        const raw = typeof args?.packages === 'string' ? args.packages : ''
        if (!raw.trim()) return deps.updatable.map((d) => d.name)
        return raw.split(',').map((s) => s.trim())
      }

      if (action === 'list') {
        const lines = []
        lines.push('=== 插件更新清单 ===')
        lines.push('可更新（npm 装的）：' + deps.updatable.length + ' 个')
        for (const d of deps.updatable.slice(0, 40)) lines.push('  ' + d.name + '  ' + d.spec)
        if (deps.updatable.length > 40) lines.push('  …还有 ' + (deps.updatable.length - 40) + ' 个')
        lines.push('')
        lines.push('不可更新（link 装的，指向本地目录，没有「新版本」这个概念）：' + deps.linked.length + ' 个')
        for (const d of deps.linked) lines.push('  ' + d.name + '  ' + d.spec)
        lines.push('')
        lines.push('想真更新：action=plan 预演 → action=run 执行。')
        return { text: lines.join('\n') }
      }

      const names = parseNames()

      if (action === 'plan') {
        return { text: renderUpdateReport(await updatePlugins(names, { dryRun: true })) }
      }

      if (action === 'run') {
        const real = args?.dryRun === false
        const r = await updatePlugins(names, { dryRun: !real })
        return { text: renderUpdateReport(r) }
      }

      return { text: '未知 action：' + action + '（可选 list / plan / run）' }
    },
  }))

  safeRegister('atlas_patch', () => defineTool({
    name: 'atlas_patch',
    description: '补丁台账：查看所有已知补丁现在是否还在、锚点是否还有效、是否需要断硬链接。' +
      'action=check 只读检查；action=snapshot 存快照；action=repair 重放失配的补丁（会自动备份）。',
    parameters: {
      action: { type: 'string', description: '可选。check（默认）/ snapshot / repair' },
      dryRun: { type: 'boolean', description: '可选。repair 时只演练不写盘' },
    },
    output: textResult(),
    async execute(args) {
      const action = typeof args?.action === 'string' ? args.action.trim().toLowerCase() : 'check'
      const dryRun = args?.dryRun === true

      if (action === 'snapshot') {
        const { results } = checkAllPatches(root)
        const patches = results.map((r) => r.patch).filter((p) => p && p.target)
        const snap = createSnapshot(patches, { root, label: 'manual' })
        return {
          text: [
            '快照已保存',
            `目录：${snap.dir}`,
            `文件：${snap.manifest.files.length} 个`,
            `缺失：${snap.manifest.missing.length} 个`,
            ...snap.manifest.files.slice(0, 10).map((f) => `  ${f.saved}  ${f.size} 字节`),
          ].join('\n'),
        }
      }

      const { summary: s, results } = checkAllPatches(root)

      if (action === 'repair') {
        const lines = [`补丁修复（${dryRun ? '演练模式' : '实际写入'}）`, '']
        let fixed = 0
        let skipped = 0
        for (const r of results) {
          const p = r.patch
          if (r.status === 'applied') continue
          if (r.status !== 'missing') {
            lines.push(`  跳过 ${p.id}：${r.status} —— ${r.detail}`)
            skipped++
            continue
          }
          if (p.manual) {
            lines.push(`  跳过 ${p.id}：需人工处理（该补丁是改写型，不能自动重放）`)
            skipped++
            continue
          }
          const res = applyPatch(p, { dryRun })
          lines.push(`  ${res.ok ? '✓' : '✗'} ${p.id}：${res.action} —— ${res.detail}`)
          recordLedger({
            root,
            patch: p.id,
            action: dryRun ? 'repair-dryrun' : 'repair',
            result: res.ok ? res.action : 'failed',
            detail: res.detail,
            pluginId: pluginIdFromTarget(p.target),
          })
          if (res.ok && res.action !== 'noop') fixed++
        }
        lines.push('', `结果：修复 ${fixed}，跳过 ${skipped}`)
        return { text: lines.join('\n') }
      }

      for (const r of results) {
        recordLedger({
          root,
          patch: r.patch?.id || '(unknown)',
          action: 'check',
          result: r.status,
          detail: r.detail,
          pluginId: pluginIdFromTarget(r.patch?.target),
        })
      }
      const lines = [
        '=== 补丁健康度 ===',
        `共 ${s.total} 个｜在线 ${s.applied}｜可重放 ${s.missing}｜锚点失效 ${s.anchorMissing}｜文件缺失 ${s.fileMissing}`,
        '',
      ]
      for (const r of results) {
        const p = r.patch
        const icon = r.status === 'applied' ? '✓' : r.status === 'missing' ? '△' : '✗'
        lines.push(`${icon} [${p.severity || '?'}] ${p.id}`)
        lines.push(`    ${p.name || ''}`)
        lines.push(`    ${r.detail}`)
        if (r.target && hardlinkCount(r.target) > 1) {
          lines.push('    ⚠️ 该文件有多个硬链接：写入前必须先断链，否则污染 pnpm 全局 store')
        }
        lines.push('')
      }
      lines.push('用 action=repair 重放「可重放」的补丁；manual 标记的需人工处理。')
      return { text: lines.join('\n') }
    },
  }))

  safeRegister('atlas_snapshot', () => defineTool({
    name: 'atlas_snapshot',
    description: '升级前的安全网：给所有补丁目标文件存快照，升级后可用 diff 判断补丁还在不在、上游改了什么。' +
      'action=create 存一份；action=list 列出历史；action=diff 与最近一份对比。',
    parameters: {
      action: { type: 'string', description: '可选。create（默认）/ list / diff' },
    },
    output: textResult(),
    async execute(args) {
      const action = typeof args?.action === 'string' ? args.action.trim().toLowerCase() : 'create'

      if (action === 'list') {
        const snaps = listSnapshots(root)
        if (!snaps.length) return { text: '还没有任何快照。' }
        const lines = [`共 ${snaps.length} 份快照：`, '']
        for (const s of snaps.slice(0, 15)) {
          const when = s.at ? new Date(s.at).toLocaleString('zh-CN') : '?'
          lines.push(`${when}  ${s.label}  ${s.files?.length || 0} 个文件`)
        }
        return { text: lines.join('\n') }
      }

      if (action === 'diff') {
        const snaps = listSnapshots(root)
        if (!snaps.length) return { text: '没有可对比的快照。先 action=create 存一份。' }
        const latest = snaps[0]
        const d = diffSnapshot(latest.dir)
        const lines = [
          `与快照「${new Date(latest.at).toLocaleString('zh-CN')} ${latest.label}」对比：`,
          `未变 ${d.unchanged}｜已变 ${d.changed.length}｜文件消失 ${d.missing.length}`,
          '',
        ]
        for (const c of d.changed.slice(0, 15)) {
          lines.push(`  变了：${c.file}`)
        }
        for (const m of d.missing.slice(0, 10)) {
          lines.push(`  没了：${m.file}`)
        }
        if (d.changed.length) {
          lines.push('', '提示：文件变了说明可能被上游覆盖，用 atlas_patch 查补丁状态，再用 repair 重放。')
        }
        return { text: lines.join('\n') }
      }

      const { results } = checkAllPatches(root)
      const patches = results.map((r) => r.patch).filter((p) => p && p.target)
      const snap = createSnapshot(patches, { root, label: 'manual' })
      return {
        text: [
          '快照已保存',
          `目录：${snap.dir}`,
          `文件 ${snap.manifest.files.length} 个｜缺失 ${snap.manifest.missing.length} 个`,
        ].join('\n'),
      }
    },
  }))

  safeRegister('atlas_surface', () => defineTool({
    name: 'atlas_surface',
    description: '工具面四象限：宿主声明过哪些工具、各自被调用过几次，重点列出「声明了但一次都没用过」的那批。' +
      '数据来自会话里的 request/header.tools 与 tool/call，是事实不是猜测。',
    parameters: {
      family: { type: 'string', description: '可选。只看某个家族：mcp / memory / subagent / browser / desktop / taskboard / atlas / other' },
      limit: { type: 'number', description: '可选。每段最多几条，默认 30' },
    },
    output: textResult(),
    async execute(args) {
      const family = typeof args?.family === 'string' ? args.family.trim().toLowerCase() : ''
      const raw = Number(args?.limit)
      const limit = Number.isFinite(raw) ? Math.max(1, Math.min(200, Math.floor(raw))) : 30
      const db = openDb(root)
      try {
        const surface = analyzeSurface(db)
        if (!surface.totals.surface) {
          return { text: '还没有工具面数据。先跑一次 atlas_scan（需要一次全量扫描才能读到 request/header.tools）。' }
        }

        let ownerOf = new Map()
        if (surface.unused.length > 0) {
          try {
            const { plugins } = discoverPlugins({})
            const allNames = [...surface.hot, ...surface.cold, ...surface.unused, ...surface.ghost].map((r) => r.name)
            const attr = attributeTools(plugins, allNames)
            for (const o of attr.owners) ownerOf.set(o.tool, o.pluginId)
            for (const a of attr.ambiguous) ownerOf.set(a.tool, a.candidates.join(' | '))
          } catch {   }
        }
        return { text: renderSurface(surface, { family: family || null, limit, ownerOf }) }
      } finally {
        try { db.close() } catch {   }
      }
    },
  }))

  safeRegister('atlas_health', () => defineTool({
    name: 'atlas_health',
    description: '检查 DSH 的 profile 配置是否健康：package.json 合不合法、bundles 有没有指向不存在的包、' +
      'cordis.patch.yml 有没有会让加载失败的错误、有多少份可回滚的备份。' +
      '只读。DSH 真打不开时用 rescue.mjs（不依赖 DSH）。',
    parameters: {},
    output: textResult(),
    async execute() {
      const home = dshHome()
      const prof = join(home, 'profiles', currentProfile())
      const lines = ['=== DSH profile 体检 ===', '']
      const problems = []
      const info = []

      if (!existsSync(prof)) {
        return { text: '找不到 profile 目录：' + prof }
      }

      const pkgFile = join(prof, 'package.json')
      if (!existsSync(pkgFile)) {
        problems.push('package.json 不存在')
      } else {
        try {
          const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
          const deps = Object.keys(pkg.dependencies || {}).length
          const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || []
          info.push(`package.json 合法：dependencies ${deps} 条，bundles ${bundles.length} 条`)
          const nm = join(prof, 'node_modules')
          const missing = bundles.filter((b) => {
            if (typeof b !== 'string') return false
            if (b.startsWith('@deepseek-ai/')) return false
            return !existsSync(join(nm, b))
          })
          if (missing.length) {
            problems.push(`bundles 里有 ${missing.length} 个包在 node_modules 找不到：${missing.slice(0, 5).join(', ')}`)
          }
        } catch (error) {
          problems.push('package.json 不是合法 JSON：' + String(error.message).slice(0, 120))
        }
      }

      try {
        const baks = readdirSync(prof).filter((n) => /\.bak([-.].*)?$/.test(n))
        info.push(`可用备份 ${baks.length} 份`)
        if (!baks.length) problems.push('没有任何备份 —— 出问题时无法回滚')
      } catch {   }

      for (const i of info) lines.push('  ✓ ' + i)
      for (const p of problems) lines.push('  ✗ ' + p)
      lines.push('')
      lines.push(problems.length
        ? `结论：发现 ${problems.length} 个问题。`
        : '结论：没发现问题。')
      lines.push('')
      lines.push('DSH 真打不开时（这个插件也加载不了），用不依赖 DSH 的急救脚本：')
      lines.push('  node ' + RESCUE_PATH + ' check')
      lines.push('（该脚本只用到 node 自身，不需要 DSH 启动，也不需要联网）')
      return { text: lines.join('\n') }
    },
  }))

  safeRegister('atlas_verify', () => defineTool({
    name: 'atlas_verify',
    description: '验证一个插件改动是否可用：L1 语法 → L2 真加载 → L3 模拟 ctx 跑 apply → L4 跑它自己的自测。' +
      '每层在独立子进程里跑，崩了不会拖垮宿主。注意：只做语法检查是不够的（实测挡不住「import 不存在的导出」这类错误）。',
    parameters: {
      plugin: { type: 'string', description: '插件包名（装机目录里的名字），例如 dsh-atlas' },
      selfTests: { type: 'boolean', description: '是否跑包自带的 verify-*.mjs（默认 true，慢但最有效）' },
    },
    output: textResult(),
    async execute(args) {
      const id = typeof args?.plugin === 'string' ? args.plugin.trim() : ''
      if (!id) return { text: '要给一个插件包名，例如 dsh-atlas' }
      if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(id)) return { text: '包名不合法：' + id }

      const nm = pathJoin(profileDir(), 'node_modules')
      const pkgDir = pathJoin(nm, id)
      if (!existsSync(pkgDir)) return { text: `没找到插件目录：${pkgDir}` }

      let entry = pathJoin(pkgDir, 'lib', 'index.js')
      try {
        const pkg = JSON.parse(readFileSync(pathJoin(pkgDir, 'package.json'), 'utf8'))
        const main = typeof pkg.main === 'string' ? pkg.main : null
        if (main) {
          const candidate = pathJoin(pkgDir, main)
          if (existsSync(candidate)) entry = candidate
        }
      } catch {   }
      if (!existsSync(entry)) return { text: `找不到入口文件：${entry}` }

      const r = await verifyPluginChange({
        pkgDir,
        entryFile: entry,
        runSelfTests: args?.selfTests !== false,
      })

      const lines = [`=== ${id} 验证 ===`, '']
      for (const l of r.levels) {
        const mark = l.ok ? (l.skipped ? '?' : '✓') : '✗'
        lines.push(`  ${mark} ${(l.label || l.level).padEnd(16)}${l.detail}`)
      }
      lines.push('')
      const skipped = r.levels.filter((l) => l.skipped).length
      if (r.verdict === 'fail') {
        lines.push('结论：有层没过，这个改动不能上。')
      } else if (r.verdict === 'partial') {
        lines.push(`结论：没有发现错误，但有 ${skipped} 层判不了` +
          '（多半是依赖宿主内置包，子进程里只能用桩顶替）。')
        lines.push('这种"判不了"不等于通过 —— 改动前请再想一下这段代码会不会影响别处。')
      } else {
        lines.push('结论：四层全部通过。')
      }
      lines.push('')
      lines.push('「通过」不等于「没问题」，以下这些这四层看不到：')
      for (const u of r.unverified) lines.push('  · ' + u)
      return { text: lines.join('\n') }
    },
  }))

  safeRegister('atlas_skills', () => defineTool({
    name: 'atlas_skills',
    description: '技能面：本机装了哪些技能、各自被调用过几次、哪些从没用过。' +
      '技能和工具不同 —— 模型要先调 skill(name) 才会读到技能正文，没调过就是真没用过。' +
      '只读，不删不禁用。「没用过」不等于「该删」，只报事实。',
    parameters: {},
    output: textResult(),
    async execute() {
      const db = openDb(root)
      try {
        const usage = skillUsage(db)
        const analysis = analyzeSkills(listSkills(), usage.byName)
        return { text: renderSkills(analysis) }
      } finally {
        try { db.close() } catch {   }
      }
    },
  }))

  safeRegister('atlas_dryrun', () => defineTool({
    name: 'atlas_dryrun',
    description: '隔离试运行：在临时目录起一个 DSH 实例，验证「这堆插件一起能不能加载」。' +
      '跑完自动删干净，不碰 ~/.dsh 的 sessions，不用 API key。' +
      '**已做隔离**：会摘掉前端 UI 插件（它们会抢 3080 端口并在浏览器里弹页面），' +
      '并设 BROWSER=none / PORT=0，所以不会弹任何浏览器。' +
      '注意：desktop 的插件依赖宿主内置包，CLI 环境里拿不到，结果常是「环境受限」。',
    parameters: {
      timeoutMs: { type: 'number', description: '子进程超时毫秒，默认 30000' },
      confirm: { type: 'boolean', description: '必须显式传 true 才会真跑。会起隔离实例、可能弹浏览器。' },
    },
    output: textResult(),
    async execute(args) {
      if (args?.confirm !== true) {
        return {
          text: [
            '=== 隔离试运行（未执行）===',
            '',
            '这个工具会**真起一个 DSH 实例**，因此默认不跑。',
            '',
            '如果要跑，显式传 confirm: true。',
            '',
            '会做什么：',
            '  · 在 %TEMP% 建临时 DSH_HOME（不碰你的 ~/.dsh）',
            '  · 复制你的 profile 配置，但摘掉会抢端口的插件（dshmarket 等）',
            '  · node_modules 用 junction 指过去（不复制内容）',
            '  · 跑完删掉整个临时目录',
            '',
            '为什么不会弹 3080：',
            '  · 隔离实例的 package.json 里，dshmarket / better-sidebar / ui-market 被从 bundles 摘掉',
            '  · DSH 只加载 bundles 里列出的包（读它们的 cordis.patch.yml）',
            '  · 不在 bundles 里 = 不会被加载，跟 node_modules 是不是 junction 无关',
            '  · 外加 BROWSER=none / PORT=0 双保险',
          ].join('\n'),
        }
      }

      const r = await dryRun({
        profileName: currentProfile(),
        timeoutMs: Number.isFinite(args?.timeoutMs) ? args.timeoutMs : 30000,
      })

      const lines = ['=== 隔离试运行 ===', '']
      const mark = r.verdict === 'pass' ? '✓ 通过'
        : r.verdict === 'fail' ? '✗ 失败'
        : r.verdict === 'environment-limited' ? '? 环境受限（判不了）'
        : '? 无法判定'
      lines.push('结论：' + mark)
      lines.push('')

      if (r.error) lines.push('错误：' + r.error)
      if (r.failedEntries && r.failedEntries.length) {
        lines.push('没起来的插件：')
        for (const f of r.failedEntries.slice(0, 10)) {
          lines.push('  · ' + f.id + (f.envLimited ? '（宿主内置包缺失，环境限制）' : '：' + f.reason.slice(0, 100)))
        }
        if (r.failedEntries.length > 10) lines.push('  … 还有 ' + (r.failedEntries.length - 10) + ' 个')
        lines.push('')
      }

      for (const n of r.notes || []) lines.push('  - ' + n)
      lines.push('')
      lines.push('临时目录已删除：' + (r.residual ? '❌ 还有残留！' : '是'))
      lines.push('')
      lines.push('这个工具能证明什么、不能证明什么：')
      lines.push('  能：插件在真实加载器里能不能 import、能不能 apply、配置能不能合成')
      lines.push('  不能：桌面版专属路径（IPC/原生窗口）、需要宿主服务的插件、长时间稳定性')
      return { text: lines.join('\n') }
    },
  }))

  safeRegister('atlas_models', () => defineTool({
    name: 'atlas_models',
    description: '查看或修改本插件的模型配置：哪些地方要用模型、各自跟随默认还是单独指定。' +
      '不带 model 参数时只读；带 model 时写回 cordis.patch.yml 的 models 段' +
      '（写前自动备份、写后自检、不合格回滚）。',
    parameters: {
      slot: { type: 'string', description: '用途：overlap / upstreamFix / delegate（见 atlas_model_check）' },
      provider: { type: 'string', description: '可选。provider id；留空则用宿主默认 provider' },
      model: { type: 'string', description: '可选。模型 id。写这个参数才会改配置；传空字符串表示恢复「跟随默认」' },
      reasoningEffort: { type: 'string', description: '可选。推理强度，如 max / high' },
    },
    output: textResult(),
    async execute(args) {
      const only = typeof args?.slot === 'string' ? args.slot.trim() : ''
      if (only && !MODEL_SLOTS[only]) {
        return { text: `没有「${only}」这个用途。可选：${Object.keys(MODEL_SLOTS).join(' / ')}` }
      }

      const hasWrite = typeof args?.model === 'string'
      if (hasWrite) {
        if (!only) return { text: '要改配置必须同时给 slot，例如 slot="overlap" model="xxx"' }
        const wantModel = args.model.trim()
        const r = writeModelSlot({
          pkgDir: PACKAGE_ROOT,
          slot: only,
          provider: typeof args?.provider === 'string' ? args.provider.trim() : null,
          model: wantModel || null,
          reasoningEffort: typeof args?.reasoningEffort === 'string' ? args.reasoningEffort.trim() : null,
        })
        if (!r.ok) return { text: `写入失败：${r.reason || '未知原因'}` }
        const bak = r.backup ? String(r.backup).split(/[\\/]/).pop() : null
        const after = wantModel
          ? `${only} → ${args.provider ? args.provider + '/' : ''}${wantModel}${args.reasoningEffort ? '（' + args.reasoningEffort + '）' : ''}`
          : `${only} → 跟随默认模型`
        const lines = [
          '=== 已写入 ===',
          '',
          after,
          bak ? '备份：' + bak : '',
          '',
          '注意：新配置要等宿主重新加载插件才生效（dsh-unlag 的刷新按钮，或重启 DSH）。',
        ].filter(Boolean)
        return { text: lines.join('\n') }
      }

      const lines = ['=== 模型配置（全站一张表）===', '']

      const liveLlm = llmService || resolveLlm(ctx)
      lines.push('模型服务：' + (liveLlm
        ? '✅ 已就绪（可以真的调用）'
        : '❌ 不可用（依赖模型的工具会全部失效，纯规则的工具不受影响）'))
      lines.push('')

      for (const [key, desc] of Object.entries(MODEL_SLOTS)) {
        if (only && only !== key) continue
        const s = models.slots[key]
        const value = s.followsDefault
          ? '跟随默认模型'
          : (s.provider ? s.provider + '/' : '') + s.model + (s.reasoningEffort ? '（' + s.reasoningEffort + '）' : '')
        lines.push(`${key}`)
        lines.push(`  用途：${desc}`)
        lines.push(`  当前：${value}`)
        lines.push('')
      }
      lines.push('改法：在 <当前 profile>/cordis.patch.yml 里找到 id: dsh-atlas 的')
      lines.push('      config.models.<用途>，填 provider / model / reasoningEffort。')
      lines.push('      留空 {} = 跟随默认模型（推荐，不用管）。')
      if (models.warnings.length) {
        lines.push('')
        lines.push('配置提示：')
        for (const w of models.warnings) lines.push('  ! ' + w)
      }
      return { text: lines.join('\n') }
    },
  }))

  safeRegister('atlas_plugins', () => defineTool({
    name: 'atlas_plugins',
    description: '清点本机**所有** DSH 插件（含 link/Junction 安装，不漏自研与本地仓库），' +
      '给出各自的安装方式、版本、上游仓库、启停状态。这是「管所有插件」的前提。',
    parameters: {
      source: { type: 'string', description: '可选。只看某种安装方式：npm / link-junction / link-source' },
      q: { type: 'string', description: '可选。按包名或描述过滤' },
      tools: { type: 'boolean', description: '可选。true 时附带「每个插件贡献了哪些工具」' },
    },
    output: textResult(),
    async execute(args) {
      const source = typeof args?.source === 'string' ? args.source.trim().toLowerCase() : ''
      const q = typeof args?.q === 'string' ? args.q.trim().toLowerCase() : ''
      const withTools = args?.tools === true

      const { plugins, warnings } = discoverPlugins({})
      let list = plugins
      if (source) list = list.filter((p) => p.sourceType === source)
      if (q) list = list.filter((p) => p.id.toLowerCase().includes(q) || String(p.repoUrl || '').toLowerCase().includes(q))
      if (!list.length) return { text: '没有匹配的插件。' }

      const counts = new Map()
      for (const p of plugins) counts.set(p.sourceType, (counts.get(p.sourceType) || 0) + 1)

      const lines = [
        `=== 插件清单（${plugins.length} 个）===`,
        '按安装方式：' + [...counts.entries()].map(([k, v]) => `${k}=${v}`).join('｜'),
        '',
      ]
      for (const p of list.slice(0, 80)) {
        const flags = [
          p.isSelf ? '本插件' : null,
          p.inBundles ? `bundles#${p.bundleOrder}` : '未在 bundles',
          p.patchIds?.length ? `补丁${p.patchIds.length}` : null,
        ].filter(Boolean).join('｜')
        lines.push(`${p.id}@${p.version || '?'}  [${p.sourceType}]  ${flags}`)
        if (p.repoUrl) lines.push(`    ${p.repoUrl}`)
      }
      if (list.length > 80) lines.push(`…其余 ${list.length - 80} 个略`)

      if (withTools) {
        const db = openDb(root)
        try {
          const names = [...new Set([...calledToolNames(db), ...declaredToolNames(db)])]
          const attr = attributeTools(plugins, names)
          const byPlugin = new Map()
          for (const o of attr.owners) {
            byPlugin.set(o.pluginId, (byPlugin.get(o.pluginId) || []).concat([o.tool]))
          }
          lines.push('', `=== 工具归属（${attr.owners.length} 个工具，扫描 ${attr.scannedFiles} 个文件）===`)
          const sorted = [...byPlugin.entries()].sort((a, b) => b[1].length - a[1].length)
          for (const [pid, arr] of sorted.slice(0, 25)) {
            lines.push(`${pid}  →  ${arr.length} 个：${arr.slice(0, 8).join(', ')}${arr.length > 8 ? ' …' : ''}`)
          }
          if (attr.ambiguous?.length) {
            lines.push('', `${attr.ambiguous.length} 个工具命中多个插件（不猜）：`)
            for (const a of attr.ambiguous.slice(0, 8)) lines.push(`  ${a.tool} → ${a.candidates.join(' | ')}`)
          }
          if (attr.unattributed?.length) {
            lines.push('', `${attr.unattributed.length} 个工具没找到定义式（多半是宿主内置）：`)
            lines.push('  ' + attr.unattributed.slice(0, 20).join(', '))
          }
        } finally { try { db.close() } catch {   } }
      }

      if (warnings?.length) {
        lines.push('', `（${warnings.length} 条读取警告，例如某些目录读不到）`)
      }
      return { text: lines.join('\n') }
    },
  }))

  safeRegister('atlas_overlap', () => defineTool({
    name: 'atlas_overlap',
    description: '统一层模型：把记忆层 / 人格层 / 工具层放在**同一套算法**下判定重叠，' +
      '回答「两个后端是可以共存，还是只需要留一个」。三层只有 layer 字段不同，判定逻辑完全一致。' +
      '只读磁盘，不改任何记忆或人格文件。',
    parameters: {
      layer: { type: 'string', description: '可选。只看某一层：memory / persona / tool；留空看全部' },
      limit: { type: 'number', description: '可选。返回条数，默认 20' },
      ai: { type: 'boolean', description: '可选。true = 让模型复核 unverified 的配对（默认 false，纯规则）' },
    },
    output: textResult(),
    async execute(args) {
      const layer = typeof args?.layer === 'string' ? args.layer.trim().toLowerCase() : ''
      const raw = Number(args?.limit)
      const limit = Number.isFinite(raw) ? Math.max(1, Math.min(200, Math.floor(raw))) : 20
      const useAi = args?.ai === true

      const { items, warnings } = collectLayers({})
      if (!items.length) return { text: '没有发现任何层后端。检查 ~/.dsh 与 ~/.mnemon 是否存在。' }
      let overlaps = findOverlaps(items)

      let aiNote = ''
      if (useAi) {
        const llm = llmService || resolveLlm(ctx)
        const r = await aiReviewOverlaps(overlaps, items, { llm, resolved: models, ctx: defaultModelContext })
        if (!r.ok && r.errors.length) {
          aiNote = 'AI 复核不可用：' + r.errors[0]
        } else if (r.checked === 0) {
          aiNote = '没有需要 AI 复核的配对（规则已经全部判出结论）'
        } else {
          const upgradedKeys = new Set(r.upgraded.map((u) => u.layer + '|' + u.a + '|' + u.b))
          overlaps = overlaps.map((o) => {
            const hit = upgradedKeys.has(o.layer + '|' + o.a + '|' + o.b)
            return hit ? r.upgraded.find((u) => u.layer === o.layer && u.a === o.a && u.b === o.b) : o
          })
          aiNote = 'AI 复核了 ' + r.checked + ' 对，改判 ' + r.upgraded.length + ' 对'
            + (r.skipped ? ('，还有 ' + r.skipped + ' 对没审（单次上限）') : '')
            + (r.errors.length ? ('；失败 ' + r.errors.length + ' 对') : '')
        }
      }
      const byLayer = new Map()
      for (const it of items) {
        const k = it.layer
        byLayer.set(k, (byLayer.get(k) || []).concat([it]))
      }
      const lines = ['=== 统一层模型（记忆 / 人格 / 工具同一套判定算法）===', '']
      for (const k of ['memory', 'persona', 'tool']) {
        const arr = byLayer.get(k) || []
        if (layer && layer !== k) continue
        lines.push(`== ${k} 层 ==（${arr.length} 个后端）`)
        for (const it of arr.slice(0, limit)) {
          lines.push(`  · ${it.backendId}` + (it.storePath ? `  ${it.storePath}` : '') + (it.active ? '' : '  [未激活]'))
          if (it.scope) lines.push(`      scope=${it.scope}` + (it.readApi ? `｜读=${it.readApi}` : ''))
        }
        const sub = overlaps.filter((o) => o.layer === k)
        const coexist = sub.filter((o) => o.verdict === 'coexist').length
        const keepOne = sub.filter((o) => o.verdict === 'keep-one').length
        const unv = sub.filter((o) => o.verdict === 'unverified').length
        lines.push(`  重叠 ${sub.length} 组｜共存 ${coexist}｜二选一 ${keepOne}｜未定 ${unv}`)
        for (const o of sub.filter((x) => x.verdict !== 'coexist').slice(0, 8)) {
          lines.push(`    [${o.verdict}] ${o.a} ↔ ${o.b}  score=${(o.score ?? 0).toFixed(2)}  (${o.kind})`)
          for (const e of (o.evidence || []).slice(0, 2)) lines.push(`        ${e}`)
        }
        lines.push('')
      }
      if (warnings?.length) {
        lines.push(`（${warnings.length} 条警告，例如某些插件的工具名写法没对上静态锚，工具层结果是下界）`)
      }
      if (aiNote) lines.push('', 'AI 复核：' + aiNote)
      lines.push('要看具体该怎么处理，用 atlas_remediate（只出方案，不动手）。')
      return { text: lines.join('\n') }
    },
  }))

  safeRegister('atlas_remediate', () => defineTool({
    name: 'atlas_remediate',
    description: '把层重叠裁决翻译成**可审阅的净化方案**：哪个留、哪个停、会改到哪些文件、怎么撤销。' +
      '本工具绝不修改任何文件——停用插件是破坏性动作，必须由人确认后再动手。',
    parameters: {
      layer: { type: 'string', description: '可选。只看某一层：memory / persona / tool' },
      limit: { type: 'number', description: '可选。返回条数，默认 20' },
    },
    output: textResult(),
    async execute(args) {
      const layer = typeof args?.layer === 'string' ? args.layer.trim().toLowerCase() : ''
      const raw = Number(args?.limit)
      const limit = Number.isFinite(raw) ? Math.max(1, Math.min(200, Math.floor(raw))) : 20

      const { items } = collectLayers({})
      let overlaps = findOverlaps(items)
      if (layer) overlaps = overlaps.filter((o) => o.layer === layer)
      const state = readProfileState()
      const plan = buildRemediationPlan(overlaps, { profileState: state })
      return { text: renderRemediation(plan, { limit }) }
    },
  }))

  safeRegister('atlas_patrol', () => defineTool({
    name: 'atlas_patrol',
    description: '每日巡检：查所有插件的上游版本，判断升级会不会撞上你的补丁，并落一份报告。' +
      'action=run 立即跑；action=status 看上次跑了没；action=report 读最近一份报告。' +
      '只读 npm registry 与 GitHub 公开 API，不发送本机内容、不自动改代码、不自动装包。',
    parameters: {
      action: { type: 'string', description: '可选。run（默认）/ status / report' },
      maxNetwork: { type: 'number', description: '可选。单次最多网络请求数，默认 12' },
    },
    output: textResult(),
    async execute(args) {
      const action = typeof args?.action === 'string' ? args.action.trim().toLowerCase() : 'run'
      const raw = Number(args?.maxNetwork)
      const maxNetwork = Number.isFinite(raw) ? Math.max(0, Math.min(60, Math.floor(raw))) : 12

      if (action === 'status') {
        const info = patrolDueInfo(root, 24)
        const lines = [
          '=== 巡检状态 ===',
          `上次巡检：${info.lastRunAt ? new Date(info.lastRunAt).toLocaleString('zh-CN') : '从未跑过'}`,
          `距现在：${info.ageHours === null ? '—' : info.ageHours.toFixed(1) + ' 小时'}`,
          `是否需要跑：${info.due ? '需要' : '还不到 24 小时'}`,
        ]
        return { text: lines.join('\n') }
      }

      if (action === 'report') {
        const state = readPatrolState(root)
        const dir = join(root, 'reports')
        if (!existsSync(dir)) return { text: `还没有任何巡检报告（${dir} 不存在）。用 action=run 跑一次。` }
        const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
        if (!files.length) return { text: '报告目录是空的。用 action=run 跑一次。' }
        const latest = join(dir, files[files.length - 1])
        const text = readFileSync(latest, 'utf8')
        return { text: `${latest}\n\n` + text.slice(0, 6000) + (text.length > 6000 ? '\n…（已截断）' : '') }
      }

      let plugins = null
      try {
        const discovered = discoverPlugins({})
        if (discovered.plugins?.length) plugins = discovered.plugins
      } catch {   }

      const result = await runPatrol({ root, maxNetwork, plugins })
      return { text: renderPatrol(result) }
    },
  }))

  safeRegister('atlas_drift', () => defineTool({
    name: 'atlas_drift',
    description: '找出「本地被改过的插件文件」——这就是补丁的自动来源，不用手写 known-patches.json。' +
      'action=scan 用硬链接断链指纹快扫（本地、零网络）；action=diff 下载同版本 tarball 逐文件比对，直接说出改了哪几行。',
    parameters: {
      action: { type: 'string', description: '可选。scan（默认）/ diff' },
      plugin: { type: 'string', description: '可选。只查某个包名；留空则扫全部' },
    },
    output: textResult(),
    async execute(args) {
      const action = typeof args?.action === 'string' ? args.action.trim().toLowerCase() : 'scan'
      const only = typeof args?.plugin === 'string' ? args.plugin.trim() : ''

      let plugins = []
      try { plugins = inventoryPlugins() } catch { plugins = [] }
      plugins = plugins.map((p) => ({ ...p, id: p.name, sourceType: sourceTypeOf(p.dir, p.name) }))
      if (only) plugins = plugins.filter((p) => p.name === only)
      if (!plugins.length) plugins = [{ name: only || '(all)', version: null, dir: null, sourceType: 'unknown' }]

      if (action === 'diff') {
        const target = plugins.find((p) => p.name === only) || plugins[0]
        if (!target || !target.name || target.name === '(all)') {
          return { text: 'diff 需要指定一个包名：atlas_drift action=diff plugin=<包名>' }
        }
        const r = await diffAgainstRegistry(target, { cacheDir: join(root, 'cache', 'tarballs') })
        const lines = [`=== ${target.name}@${target.version || '?'} tarball 比对 ===`, `状态：${r.status}`]
        if (r.error) lines.push(`原因：${r.error}`)
        if (r.changed?.length) {
          lines.push('', `有 ${r.changed.length} 个文件和 registry 原包不一致：`)
          for (const c of r.changed.slice(0, 15)) {
            lines.push(`  · ${c.file}  +${c.added ?? '?'}/-${c.removed ?? '?'}`)
            if (c.sample) lines.push(`      样本：${String(c.sample).slice(0, 100)}`)
          }
        }
        if (r.added?.length) lines.push('', `本地多出 ${r.added.length} 个文件（registry 里没有）`)
        if (r.removed?.length) lines.push('', `本地缺少 ${r.removed.length} 个 registry 里的文件`)
        if (r.status === 'ok' && !r.changed?.length) lines.push('', '本地与 registry 原包逐文件一致：没有本地改动。')
        return { text: lines.join('\n') }
      }

      const lines = ['=== 本地改动快扫（硬链接断链指纹）===', '']
      let totalScanned = 0
      const hits = []
      for (const p of plugins) {
        const r = scanLocalModifications(p)
        totalScanned += r.scanned || 0
        if (p.sourceType !== 'npm') {
          lines.push(`${p.name}｜${p.sourceType}｜跳过（${r.reason || 'link 包 nlink 启发式失效'}）`)
          continue
        }
        const real = (r.modified || []).filter((m) => m.reason === 'nlink-1')
        if (real.length) {
          lines.push(`${p.name}｜扫描 ${r.scanned} 个文件｜**命中 ${real.length} 个被改文件**`)
          for (const m of real.slice(0, 10)) {
            hits.push({ plugin: p, file: m })
            lines.push(`  · ${m.file}（${m.size} 字节）`)
          }
        }
      }
      lines.push('', `合计扫描 ${totalScanned} 个文件，命中 ${hits.length} 个本地被改文件。`)
      if (hits.length) {
        lines.push('', '这些文件都可以用 atlas_drift action=diff plugin=<包名> 拿到「具体改了哪几行」的证据，')
        lines.push('再决定要不要把它变成补丁记录（变成补丁需要人确认，自动发现只能说「不一样」）。')
      }
      return { text: lines.join('\n') }
    },
  }))

  safeRegister('atlas_ledger', () => defineTool({
    name: 'atlas_ledger',
    description: '补丁台账：每次打补丁/重放/巡检都追加一条流水（append-only，永不被改写）。' +
      'action=summary 看每个补丁最后一次动作；action=tail 看最近明细。',
    parameters: {
      action: { type: 'string', description: '可选。summary（默认）/ tail' },
      patch: { type: 'string', description: '可选。只看某个补丁 id' },
      limit: { type: 'number', description: '可选。条数，默认 20' },
    },
    output: textResult(),
    async execute(args) {
      const action = typeof args?.action === 'string' ? args.action.trim().toLowerCase() : 'summary'
      const patch = typeof args?.patch === 'string' ? args.patch.trim() : ''
      const raw = Number(args?.limit)
      const limit = Number.isFinite(raw) ? Math.max(1, Math.min(200, Math.floor(raw))) : 20

      if (action === 'tail') {
        const res = readLedger({ root, limit, patch: patch || null })
        if (!res.entries.length) return { text: `台账还没有记录（${ledgerPath(root)}）。` }
        const lines = [`最近 ${res.entries.length} 条流水（共 ${res.total} 条匹配）`, '']
        for (const e of res.entries) {
          const when = e.at ? new Date(e.at).toLocaleString('zh-CN') : '?'
          lines.push(`${when}  ${e.patch || '(无)'}  ${e.action}/${e.result}` + (e.detail ? ` — ${e.detail}` : ''))
        }
        if (res.brokenLines) lines.push('', `（跳过 ${res.brokenLines} 行损坏记录）`)
        return { text: lines.join('\n') }
      }

      const s = ledgerSummary({ root, patch: patch || null })
      return { text: renderLedger(s, { limit }) }
    },
  }))

  safeRegister('atlas_upstream', () => defineTool({
    name: 'atlas_upstream',
    description: '查所有插件的上游更新，并分析「升级会不会打断我的补丁」。' +
      '只读 npm registry 与 GitHub 公开 API，不发送任何本机内容，也不会自动改代码。',
    parameters: {
      name: { type: 'string', description: '可选。只查某一个插件（包名）；留空则查全部' },
      limit: { type: 'number', description: '可选。报告条数，默认 20' },
    },
    output: textResult(),
    async execute(args) {
      const only = typeof args?.name === 'string' ? args.name.trim() : ''
      const raw = Number(args?.limit)
      const limit = Number.isFinite(raw) ? Math.max(1, Math.min(60, Math.floor(raw))) : 20

      const { results: patchResults } = checkAllPatches(root)
      const patches = patchResults.map((r) => r.patch).filter((p) => p && p.target)

      if (only) {
        const plugins = inventoryPlugins()
        const target = plugins.find((p) => p.name === only)
        if (!target) {
          return { text: `没找到插件 ${only}。用空参数调用可看全部。` }
        }
        const remote = await npmLatest(only)
        const cmp = compareVersions(target.version, remote.latest)
        const { analyzeImpact } = await import('./upstream/upstream.js')
        const impact = analyzeImpact(patches, only, null)
        const lines = [
          `=== ${only} ===`,
          `本地 ${target.version}｜上游 ${remote.latest || '未知'}｜状态 ${cmp.status}`,
        ]
        if (remote.publishedAt) lines.push(`上游发布于 ${new Date(remote.publishedAt).toLocaleString('zh-CN')}`)
        if (impact.patches.length) {
          lines.push('', `你在这个插件上有 ${impact.patches.length} 个补丁：`)
          for (const p of impact.patches) lines.push(`  [${p.severity || '?'}] ${p.id} — ${p.name || ''}`)
        } else {
          lines.push('', '这个插件没有本地补丁。')
        }
        return { text: lines.join('\n') }
      }

      const report = await checkAllUpstream(patches)
      return { text: renderUpstreamReport(report, { limit }) }
    },
  }))

  trace(root, 'apply-done', `via=${compatState()}`)

  globalThis.__atlasTrace = (event, detail) => trace(root, event, detail)

  let defaultModelContext = ctx
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['agentDefaultModel'], (childCtx) => { defaultModelContext = childCtx || ctx })
    } catch {   }
  }
  let llmService = resolveLlm(ctx)
  if (!llmService && typeof ctx.inject === 'function') {
    try {
      ctx.inject(['llm'], (childCtx) => {
        const got = resolveLlm(childCtx)
        if (got) {
          llmService = got
          trace(root, 'llm-inject-ready', 'llm service resolved via inject')
        } else {
          trace(root, 'llm-inject-empty', 'inject fired but llm still unavailable')
        }
      })
      trace(root, 'llm-inject-declared', 'waiting for llm service')
    } catch (error) {
      trace(root, 'llm-inject-failed', String(error && error.message).slice(0, 160))
    }
  }
  if (llmService) trace(root, 'llm-available', 'llm service found at apply time')
  else trace(root, 'llm-pending', 'no llm service yet (will retry per call)')

  const mountRoutes = (routeCtx, via) => {
    try {
      try {
        const ws = routeCtx && (routeCtx.webServer || (typeof routeCtx.get === 'function' ? routeCtx.get('webServer') : null))
        if (ws) {
          const keys = Object.keys(ws).slice(0, 20).join(',')
          const prefixes = ws.prefixes && typeof ws.prefixes.keys === 'function' ? [...ws.prefixes.keys()].slice(0, 12).join(',') : 'n/a'
          const exacts = ws.exacts && typeof ws.exacts.keys === 'function' ? [...ws.exacts.keys()].slice(0, 12).join(',') : 'n/a'
          trace(root, 'webserver-shape', `keys=[${keys}] prefixes=[${prefixes}] exacts=[${exacts}]`)
        }
      } catch (error) {
        trace(root, 'webserver-shape-failed', String(error && error.message).slice(0, 160))
      }
      const r = registerRoutes(routeCtx, {
        models,
        llmReady: () => {
          const svc = llmService || resolveLlm(routeCtx)
          return { ready: Boolean(svc), checkedAt: Date.now() }
        },
      })
      trace(root, r.ok ? 'routes-registered' : 'routes-skipped',
        `${via} | ${r.ok ? JSON.stringify(r.routes) : r.reason}`)
      if (!r.ok) {
        try { console.error(`[dsh-atlas] UI 数据接口未启用（${via}）：${r.reason}`) } catch {   }
      }
      return r.ok
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      trace(root, 'routes-failed', `${via} | ${detail}`)
      try { console.error(`[dsh-atlas] UI 接口注册异常（${via}）：${detail}`) } catch {   }
      return false
    }
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (childCtx) => {
        mountRoutes(childCtx || ctx, 'via-inject')
      })
      trace(root, 'routes-inject-declared', 'waiting for webServer service')
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      trace(root, 'routes-inject-failed', detail)
      mountRoutes(ctx, 'via-direct-fallback')
    }
  } else {
    trace(root, 'routes-inject-unavailable', 'ctx.inject 不是函数，退回直取')
    mountRoutes(ctx, 'via-direct')
  }
  }

  resolveDefineTool()
    .then((defineTool) => {
      start(defineTool)
      scheduleDailyPatrol(root, config)
    })
    .catch((error) => {
      const detail = error instanceof Error ? error.message : String(error)
      trace(root, 'apply-failed', `resolveDefineTool: ${detail}`)
      try { console.error(`[dsh-atlas] 初始化失败：${detail}`) } catch {   }
    })
}

function scheduleDailyPatrol(root, config = {}) {
  const intervalHours = Number.isFinite(config.patrolIntervalHours) ? config.patrolIntervalHours : 24
  const tickMinutes = Number.isFinite(config.patrolTickMinutes) ? config.patrolTickMinutes : 30
  if (tickMinutes <= 0) {
    trace(root, 'patrol-disabled', 'patrolTickMinutes=0')
    return
  }
  if (scheduleDailyPatrol._started) return
  scheduleDailyPatrol._started = true

  const tick = async () => {
    try {
      const info = patrolDueInfo(root, intervalHours)
      if (!info.due) return
      trace(root, 'patrol-start', info.reason)
      const result = await runPatrol({ root })
      trace(root, 'patrol-done', `report=${result?.reportPath || '?'} cursor=${result?.cursor?.to ?? '?'}`)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      trace(root, 'patrol-failed', detail)
    }
  }

  const firstDelay = 3 * 60 * 1000
  const first = setTimeout(() => { void tick() }, firstDelay)
  if (typeof first.unref === 'function') first.unref()
  const timer = setInterval(() => { void tick() }, tickMinutes * 60 * 1000)
  if (typeof timer.unref === 'function') timer.unref()
  trace(root, 'patrol-scheduled', `every ${tickMinutes}min, interval ${intervalHours}h, first in 3min`)
}

