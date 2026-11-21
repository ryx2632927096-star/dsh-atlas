import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome, currentProfile } from '../core/paths.js'

const RISK = { info: 1, low: 2, medium: 3, high: 4 }

export function readProfileState(options = {}) {
  const home = options.home || dshHome()
  const profileName = options.profileName || currentProfile()
  const profileDir = join(home, 'profiles', profileName)
  const pkgFile = join(profileDir, 'package.json')
  const out = { ok: false, profileDir, bundles: [], dependencies: [], patchIds: [] }
  if (!existsSync(pkgFile)) {
    out.error = `找不到 ${pkgFile}`
    return out
  }
  let pkg
  try { pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) } catch (error) {
    out.error = `package.json 解析失败：${error.message}`
    return out
  }
  out.dependencies = Object.keys(pkg.dependencies || {})
  const bundles = pkg?.dsh?.profile?.bundles
  out.bundles = Array.isArray(bundles) ? bundles.filter((b) => typeof b === 'string') : []

  const patchFile = join(profileDir, 'cordis.patch.yml')
  if (existsSync(patchFile)) {
    try {
      const text = readFileSync(patchFile, 'utf8')
      out.patchIds = [...text.matchAll(/^-\s*id:\s*(.+)$/gm)].map((m) => m[1].trim().replace(/^['"]|['"]$/g, ''))
    } catch {   }
  }
  out.ok = true
  return out
}

export function buildRemediationPlan(overlaps, context = {}) {
  const state = context.profileState || null
  const plans = []
  const withheld = []
  const notes = []

  if (!Array.isArray(overlaps) || !overlaps.length) {
    notes.push('没有可处理的重叠：先跑 atlas_overlap 拿到层重叠裁决。')
    return { plans, withheld, notes }
  }

  for (const o of overlaps) {
    if (!o || !o.a || !o.b) continue

    if (o.verdict === 'unverified') {
      withheld.push({
        layer: o.layer,
        pair: [o.a, o.b],
        reason: '裁决未定（unverified）——证据不足，不给动作',
        ask: `${o.a} 与 ${o.b} 在 ${o.layer} 层是否重复？需要你确认一次，之后会记住这个决定。`,
      })
      continue
    }

    if (o.verdict === 'coexist') {
      plans.push({
        layer: o.layer,
        action: 'keep-both',
        targets: [o.a, o.b],
        risk: 'info',
        riskScore: RISK.info,
        why: '互补而非重复，两个都留着',
        evidence: o.evidence || [],
        reversible: true,
        howToUndo: '无需撤销：本方案不改任何文件',
      })
      continue
    }

    const affectedBundles = state
      ? state.bundles.filter((b) => b === o.b || b === o.a)
      : []
    if (affectedBundles.length) {
      notes.push(
        `${o.b} 出现在 profile bundles 里——真要停用它，需要同时改 package.json 的 dependencies 与 dsh.profile.bundles，属于 profile 级改动。`
      )
    }
    plans.push({
      layer: o.layer,
      action: 'keep-one',
      targets: [o.a, o.b],
      suggestedKeep: o.a,
      suggestedDisable: o.b,
      risk: 'medium',
      riskScore: RISK.medium,
      why: `${o.layer} 层重复度 ${(o.score ?? 0).toFixed(2)}：功能重叠，留一个即可`,
      evidence: o.evidence || [],
      reversible: true,
      changedFiles: state ? [join(state.profileDir, 'package.json'), join(state.profileDir, 'cordis.patch.yml')] : [],
      howToUndo: '从项目根目录恢复 package.json / cordis.patch.yml 的备份，或把被移除的条目原样加回',
      requiresHuman: true,
      humanReason: '停用插件会改变 DS 下次启动时的能力面，属于破坏性动作，必须由人确认',
    })
  }

  if (state?.ok === false) notes.push(`profile 读取失败（${state.error}），方案里不会列出会改到哪些文件。`)

  return { plans, withheld, notes }
}

export function renderRemediation(result, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : 20
  const { plans, withheld, notes } = result
  const lines = ['=== 净化方案（只出方案，不动手）===', '']

  if (!plans.length && !withheld.length) {
    lines.push('没有需要处理的项。')
    return lines.join('\n')
  }

  const actionable = plans.filter((p) => p.action === 'keep-one')
  const keepBoth = plans.filter((p) => p.action === 'keep-both')

  if (actionable.length) {
    lines.push(`--- 建议二选一（${actionable.length} 组，需你确认）---`)
    for (const p of actionable.slice(0, limit)) {
      lines.push(`[${p.layer}] ${p.suggestedKeep}  ← 留；${p.suggestedDisable}  ← 建议停用`)
      lines.push(`    理由：${p.why}`)
      if (p.changedFiles?.length) lines.push(`    会改到：${p.changedFiles.join('、')}`)
      lines.push(`    撤销：${p.howToUndo}`)
      for (const e of (p.evidence || []).slice(0, 3)) lines.push(`    证据：${e}`)
      lines.push('')
    }
  }

  if (keepBoth.length) {
    lines.push(`--- 建议共存（${keepBoth.length} 组）---`)
    for (const p of keepBoth.slice(0, limit)) {
      lines.push(`[${p.layer}] ${p.targets[0]} + ${p.targets[1]} —— ${p.why}`)
    }
    lines.push('')
  }

  if (withheld.length) {
    lines.push(`--- 暂不给动作（${withheld.length} 组）---`)
    for (const w of withheld.slice(0, limit)) {
      lines.push(`[${w.layer}] ${w.pair[0]} vs ${w.pair[1]}：${w.reason}`)
    }
    lines.push('')
  }

  for (const n of notes) lines.push(`注：${n}`)
  lines.push('', '本工具**不会**修改任何文件。要真正执行，请明确指定哪一组、并让我按 changes 列出的文件动手。')
  return lines.join('\n')
}
