import { askJson } from './llm.js'

export const MAX_PAIRS_PER_RUN = 8

const SYSTEM = [
  '你是 DSH（DeepSeek Harness）插件管理助手，负责判断两个插件是否在做同一件事。',
  '',
  '判断标准：',
  '  keep-one  = 它们抢同一个位置，同时装会互相干扰，应该只留一个',
  '  coexist   = 功能相关但各管一段，可以一起装',
  '  unverified= 信息不足，无法判断',
  '',
  '**不要猜。** 信息不够就答 unverified，这比编一个结论好。',
].join('\n')

function describePair(o, items) {
  const find = (id) => items.find((x) => x.backendId === id) || {}
  const a = find(o.a)
  const b = find(o.b)
  const line = (x, tag) => {
    const parts = []
    parts.push('[' + tag + '] ' + (x.backendId || '?'))
    if (x.pluginId) parts.push('插件：' + x.pluginId)
    if (x.layer) parts.push('层：' + x.layer)
    if (x.facts && x.facts.domain) parts.push('能力域：' + x.facts.domain)
    if (x.description) parts.push('描述：' + String(x.description).slice(0, 200))
    if (x.facts && Array.isArray(x.facts.toolNames) && x.facts.toolNames.length) {
      parts.push('注册的工具：' + x.facts.toolNames.slice(0, 12).join(', '))
    }
    return parts.join(' · ')
  }
  return [
    '规则引擎已经算过一遍，结论是 unverified（证据不足）。请你补充判断。',
    '',
    '规则给出的分数：' + o.score,
    '规则推断的类型：' + o.kind,
    '规则找到的证据：',
    ...(o.evidence || []).map((e) => '  - ' + e),
    '',
    line(a, 'A'),
    line(b, 'B'),
  ].join('\n')
}

export async function aiReviewOverlaps(overlaps, items, opts = {}) {
  const llm = opts.llm
  const resolved = opts.resolved
  const limit = Math.max(1, Math.min(MAX_PAIRS_PER_RUN, Number(opts.limit) || MAX_PAIRS_PER_RUN))

  const pending = (overlaps || []).filter((o) => o.verdict === 'unverified')
  const batch = pending.slice(0, limit)

  if (!llm) {
    return { ok: false, checked: 0, upgraded: [], skipped: pending.length, errors: ['当前没有可用的模型服务'] }
  }
  if (!batch.length) {
    return { ok: true, checked: 0, upgraded: [], skipped: 0, errors: [] }
  }

  const upgraded = []
  const errors = []

  for (const o of batch) {
    try {
      const r = await askJson({
        llm,
        resolved,
        ctx: opts.ctx,
        slot: 'overlap',
        system: SYSTEM,
        prompt: describePair(o, items) + '\n\n请输出：{"verdict":"keep-one|coexist|unverified","reason":"一句话理由"}',
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
      })
      if (!r.ok) { errors.push(o.a + ' ↔ ' + o.b + '：' + r.error); continue }

      const v = r.data && r.data.verdict
      if (v !== 'keep-one' && v !== 'coexist') {
        continue
      }
      upgraded.push({
        layer: o.layer,
        a: o.a,
        b: o.b,
        kind: o.kind,
        score: o.score,
        verdict: v,
        evidence: (o.evidence || []).concat(['AI 复核：' + String(r.data.reason || '(未给理由)').slice(0, 200)]),
        aiReviewed: true,
      })
    } catch (e) {
      errors.push(o.a + ' ↔ ' + o.b + '：' + String(e && e.message || e))
    }
  }

  return {
    ok: errors.length === 0,
    checked: batch.length,
    upgraded,
    skipped: Math.max(0, pending.length - batch.length),
    errors,
  }
}
