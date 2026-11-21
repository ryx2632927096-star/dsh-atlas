import { aiReviewOverlaps, MAX_PAIRS_PER_RUN } from '../lib/ai/ai-overlap.js'

let pass = 0, fail = 0
const check = (n, ok, d) => { if (ok) { pass++; console.log('  PASS ' + n + (d?'  ('+d+')':'')) } else { fail++; console.log('  FAIL ' + n + '  → ' + d) } }

const items = [
  { backendId: 'mem-a', layer: 'memory', pluginId: 'dsh-mem-a', description: '按会话做摘要', facts: { domain: 'memory.durable-recall' } },
  { backendId: 'mem-b', layer: 'memory', pluginId: 'dsh-mem-b', description: '把对话压缩成要点', facts: { domain: 'memory.durable-recall' } },
]
const overlaps = [
  { layer: 'memory', a: 'mem-a', b: 'mem-b', kind: 'conflict', verdict: 'unverified', score: 0.5,
    evidence: ['能力槽位相同：memory.durable-recall'] },
]
const host = { get(name) { return name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) } : null } }

console.log('=== 1. 模型改判 unverified → keep-one ===')
const llmYes = {
  async *stream() {
    yield { type: 'text-delta', text: '{"verdict":"keep-one","reason":"两个都是会话摘要，会写同一份索引"}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}
const r1 = await aiReviewOverlaps(overlaps, items, { llm: llmYes, resolved: { slots: {} }, ctx: host })
check('ok', r1.ok === true, JSON.stringify(r1.errors))
check('审了 1 对', r1.checked === 1)
check('改判了 1 对', r1.upgraded.length === 1)
check('新结论是 keep-one', r1.upgraded[0] && r1.upgraded[0].verdict === 'keep-one', r1.upgraded[0] && r1.upgraded[0].verdict)
check('保留了原证据', r1.upgraded[0].evidence.some(e => e.includes('能力槽位相同')))
check('追加了 AI 理由', r1.upgraded[0].evidence.some(e => e.startsWith('AI 复核：')))
check('标记了 aiReviewed', r1.upgraded[0].aiReviewed === true)

console.log('')
console.log('=== 2. 模型也说不清 → 保持 unverified ===')
const llmNo = {
  async *stream() {
    yield { type: 'text-delta', text: '{"verdict":"unverified","reason":"信息不足"}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}
const r2 = await aiReviewOverlaps(overlaps, items, { llm: llmNo, resolved: { slots: {} }, ctx: host })
check('ok 仍为 true（没说清不算错误）', r2.ok === true)
check('没有改判', r2.upgraded.length === 0)

console.log('')
console.log('=== 3. 没有模型服务 → 如实说，不改判 ===')
const r3 = await aiReviewOverlaps(overlaps, items, { llm: null, resolved: {} })
check('ok=false', r3.ok === false)
check('错误信息人话', /没有可用的模型服务/.test(r3.errors[0]), r3.errors[0])
check('没有改判', r3.upgraded.length === 0)

console.log('')
console.log('=== 4. 只审 unverified，已判出的不动 ===')
const mixed = overlaps.concat([
  { layer: 'memory', a: 'x', b: 'y', kind: 'duplicate', verdict: 'keep-one', score: 0.9, evidence: [] },
  { layer: 'memory', a: 'p', b: 'q', kind: 'complement', verdict: 'coexist', score: 0.4, evidence: [] },
])
const r4 = await aiReviewOverlaps(mixed, items, { llm: llmYes, resolved: { slots: {} }, ctx: host })
check('只审了 1 对（那对 unverified）', r4.checked === 1, '实际 ' + r4.checked)

console.log('')
console.log('=== 5. 模型返回垃圾 → 不改判 ===')
const llmJunk = {
  async *stream() {
    yield { type: 'text-delta', text: '我觉得应该删掉一个' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}
const r5 = await aiReviewOverlaps(overlaps, items, { llm: llmJunk, resolved: { slots: {} }, ctx: host })
check('解析失败被记为错误', r5.errors.length === 1, r5.errors[0] && r5.errors[0].slice(0, 40))
check('没有改判', r5.upgraded.length === 0)

console.log('')
console.log('=== 6. 批量上限 ===')
const many = []
for (let i = 0; i < 20; i++) many.push({ layer: 'memory', a: 'a' + i, b: 'b' + i, kind: 'conflict', verdict: 'unverified', score: 0.5, evidence: [] })
const r6 = await aiReviewOverlaps(many, items, { llm: llmNo, resolved: { slots: {} }, ctx: host })
check('最多只审 ' + MAX_PAIRS_PER_RUN + ' 对', r6.checked === MAX_PAIRS_PER_RUN, '实际 ' + r6.checked)
check('其余标记为 skipped', r6.skipped === 20 - MAX_PAIRS_PER_RUN, '实际 ' + r6.skipped)

console.log('')
console.log('结果: PASS ' + pass + ' / FAIL ' + fail)
process.exitCode = fail ? 1 : 0
