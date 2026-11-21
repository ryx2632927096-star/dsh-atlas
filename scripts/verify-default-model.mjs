import assert from 'node:assert/strict'
import { test } from 'node:test'
import { routeFor, askModel, askJson } from '../lib/ai/llm.js'
import { resolveModels } from '../lib/ai/models.js'
import { aiReviewOverlaps } from '../lib/ai/ai-overlap.js'

const host = (selection) => ({
  get(name, active) {
    assert.equal(name, 'agentDefaultModel')
    assert.equal(active, false)
    return { currentSelection: () => typeof selection === 'function' ? selection() : selection }
  },
})
const config = (overlap = {}) => resolveModels({ models: { overlap } })
const defaults = { provider: 'host-provider', model: 'host-model', reasoningEffort: 'medium' }
const pinned = { provider: 'pinned-provider', model: 'pinned-model' }
const fakeStream = (inspect, text = '{"value":true}') => ({
  async *stream(request) {
    inspect?.(request)
    yield { type: 'text-delta', text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
})

test('所有空槽位读取宿主默认路由和推理强度', () => {
  for (const slot of ['overlap', 'upstreamFix', 'delegate']) {
    assert.deepEqual(routeFor(config(), slot, host(defaults)), { ...defaults, followsDefault: true })
  }
})

test('完整指定不访问默认服务，保留推理强度覆盖', () => {
  const ctx = { get() { throw new Error('不应读取默认') } }
  assert.deepEqual(routeFor(config({ ...pinned, reasoningEffort: 'high' }), 'overlap', ctx),
    { ...pinned, reasoningEffort: 'high', followsDefault: false })
})

test('仅指定model使用宿主当前provider，不继承另一模型推理强度', () => {
  assert.deepEqual(routeFor(config({ model: 'other-model' }), 'overlap', host(defaults)),
    { provider: defaults.provider, model: 'other-model', followsDefault: false })
})

test('只覆盖推理强度保留宿主默认provider/model', () => {
  assert.deepEqual(routeFor(config({ reasoningEffort: 'low' }), 'overlap', host(defaults)),
    { provider: defaults.provider, model: defaults.model, reasoningEffort: 'low', followsDefault: true })
})

test('宿主默认改变后下次路由立即跟随，不缓存启动选择', () => {
  let selected = { ...defaults }
  const ctx = host(() => selected)
  const first = routeFor(config(), 'overlap', ctx)
  selected = { provider: 'new-provider', model: 'new-model', reasoningEffort: 'low' }
  assert.deepEqual(routeFor(config(), 'overlap', ctx), { ...selected, followsDefault: true })
  assert.equal(first.model, defaults.model)
  assert.equal(routeFor(config({ model: 'override' }), 'overlap', ctx).provider, selected.provider)
})

test('服务替换后重新查服务，不持有旧服务选择', () => {
  let service = { currentSelection: () => defaults }
  const ctx = { get: () => service }
  assert.equal(routeFor(config(), 'overlap', ctx).provider, defaults.provider)
  service = { currentSelection: () => pinned }
  assert.equal(routeFor(config(), 'overlap', ctx).provider, pinned.provider)
})

test('缺失/畸形/抛错默认服务给出操作建议，不泄露内部异常', () => {
  for (const ctx of [null, {}, { get: 'bad' }, { get: () => null },
    { get: () => ({}) }, { get: () => ({ currentSelection: () => null }) },
    { get: () => ({ currentSelection: () => ({ provider: '', model: 'model' }) }) },
    { get() { throw new Error('synthetic-private-marker') } },
    { get: () => ({ currentSelection() { throw new Error('synthetic-private-marker') } }) }]) {
    assert.throws(() => routeFor(config(), 'overlap', ctx), (error) =>
      /DSH.*默认模型/.test(error.message) && /provider 和 model/.test(error.message)
      && !error.message.includes('synthetic-private-marker'))
  }
})

test('仅指定model也不能猜provider', () => {
  assert.throws(() => routeFor(config({ model: 'other' }), 'overlap', null), /默认模型/)
})

test('askJson路由失败不调用模型，完整指定无需宿主默认', async () => {
  let calls = 0
  const llm = fakeStream(() => calls++)
  const failed = await askJson({ llm, resolved: config(), slot: 'overlap' })
  assert.equal(failed.ok, false)
  assert.equal(calls, 0)
  assert.match(failed.error, /DSH.*默认模型/)
  const passed = await askJson({ llm, resolved: config(pinned), slot: 'overlap', prompt: 'synthetic' })
  assert.equal(passed.ok, true)
  assert.equal(calls, 1)
})

test('实际调用传递已解析provider/model/reasoningEffort与合法消息', async () => {
  let request
  const llm = fakeStream((value) => { request = value })
  const result = await askJson({ llm, resolved: config(), slot: 'overlap', ctx: host(defaults), prompt: 'synthetic' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.data, { value: true })
  assert.equal(request.provider, defaults.provider)
  assert.equal(request.model, defaults.model)
  assert.equal(request.reasoningEffort, defaults.reasoningEffort)
  assert.equal(request.messages[0].role, 'user')
  assert.equal(request.messages[0].content[0].text, 'synthetic')
  assert.ok(request.signal instanceof AbortSignal)
})

test('未解析路由不能绕过routeFor直接分发', async () => {
  let calls = 0
  const result = await askModel(fakeStream(() => calls++), {}, { prompt: 'synthetic' })
  assert.equal(result.ok, false)
  assert.match(result.error, /路由未解析/)
  assert.equal(calls, 0)
})

test('服务缺失和适配器异常如实失败', async () => {
  assert.equal((await askModel(null, pinned)).ok, false)
  const result = await askModel({ stream() { throw new Error('synthetic adapter failure') } }, pinned)
  assert.equal(result.ok, false)
  assert.match(result.error, /模型调用失败/)
})

test('宿主能力拒绝的finish不伪装成成功', async () => {
  const llm = { async *stream() {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'unsupported synthetic effort' } } }
  } }
  const result = await askModel(llm, { ...pinned, reasoningEffort: 'invalid' })
  assert.equal(result.ok, false)
  assert.match(result.error, /unsupported synthetic effort/)
})

test('调用前已取消，不产生模型请求', async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  const result = await askModel(fakeStream(() => calls++), pinned, { signal: controller.signal })
  assert.equal(result.ok, false)
  assert.match(result.error, /已取消/)
  assert.equal(calls, 0)
})

test('等待stream建立期间取消也返回，不把取消当超时', async () => {
  const controller = new AbortController()
  let requestSignal
  const promise = askJson({
    llm: { stream(request) { requestSignal = request.signal; return new Promise(() => {}) } },
    resolved: config(), slot: 'overlap', ctx: host(defaults), signal: controller.signal,
  })
  controller.abort()
  const result = await promise
  assert.equal(result.ok, false)
  assert.match(result.error, /已取消/)
  assert.equal(requestSignal.aborted, true)
})

test('stream不响应时超时返回并通知宿主signal', async () => {
  let requestSignal
  const result = await askModel({ stream(request) {
    requestSignal = request.signal
    return new Promise(() => {})
  } }, pinned, { timeoutMs: 10 })
  assert.equal(result.ok, false)
  assert.match(result.error, /超时/)
  assert.equal(requestSignal.aborted, true)
})

test('消费流期间取消，保留已取消结论', async () => {
  const controller = new AbortController()
  const llm = { async *stream() {
    yield { type: 'text-delta', text: 'partial' }
    controller.abort()
    yield { type: 'text-delta', text: 'late' }
  } }
  const result = await askModel(llm, pinned, { signal: controller.signal })
  assert.equal(result.ok, false)
  assert.match(result.error, /已取消/)
})

test('AI判重每一对调用均解析当前默认，错误时保持规则结论', async () => {
  let selected = { ...defaults }
  const requests = []
  const llm = fakeStream((request) => {
    requests.push({ provider: request.provider, model: request.model })
    selected = { provider: 'next-provider', model: 'next-model' }
  }, '{"verdict":"coexist","reason":"synthetic"}')
  const overlaps = ['a', 'b'].map((name) => ({ layer: 'tool', a: name, b: name + '-other', verdict: 'unverified', evidence: [] }))
  const result = await aiReviewOverlaps(overlaps, [], { llm, resolved: config(), ctx: host(() => selected) })
  assert.equal(result.checked, 2)
  assert.deepEqual(requests, [{ provider: defaults.provider, model: defaults.model }, selected])
  assert.equal(overlaps[0].verdict, 'unverified')
  const failed = await aiReviewOverlaps(overlaps, [], { llm, resolved: config() })
  assert.equal(failed.ok, false)
  assert.equal(failed.upgraded.length, 0)
  assert.equal(requests.length, 2)
})
