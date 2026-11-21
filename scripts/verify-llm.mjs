import { askModel, parseJsonLoose, routeFor, clip, resolveLlm } from '../lib/ai/llm.js'

let pass = 0, fail = 0
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS ' + name + (detail ? '  (' + detail + ')' : '')) }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  → ' + detail : '')) }
}

const fakeLlm = {
  async *stream(opts) {
    globalThis.__lastOpts = opts
    yield { type: 'text-delta', text: '可以' }
    yield { type: 'text-delta', text: '正常工作。' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

console.log('=== 1. 调用链 ===')
const r1 = await askModel(fakeLlm, { provider: 'test-provider', model: 'test-model' }, { prompt: '你能工作吗' })
check('返回 ok', r1.ok === true)
check('拼出全文', r1.text === '可以正常工作。', r1.text)
check('messages 形状对', Array.isArray(globalThis.__lastOpts.messages) && globalThis.__lastOpts.messages[0].role === 'user')
check('content 是 text 块', globalThis.__lastOpts.messages[0].content[0].type === 'text')

console.log('')
console.log('=== 2. 模型服务缺失时不崩 ===')
const r2 = await askModel(null, {}, { prompt: 'x' })
check('ok=false', r2.ok === false)
check('错误信息人话', /没有可用的 llm 服务/.test(r2.error), r2.error)

console.log('')
console.log('=== 3. JSON 容错 ===')
check('纯 JSON', JSON.stringify(parseJsonLoose('{"a":1}')) === '{"a":1}')
check('带代码块', JSON.stringify(parseJsonLoose('```json\n{"b":2}\n```')) === '{"b":2}')
check('前后有解释', JSON.stringify(parseJsonLoose('结果 {"c":3} 完成')) === '{"c":3}')
check('多余逗号', JSON.stringify(parseJsonLoose('{"d":4,}')) === '{"d":4}')
check('非 JSON 返回 null', parseJsonLoose('不是JSON') === null)

console.log('')
console.log('=== 4. 路由 ===')
const fakeCtx = { get(name) { return name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) } : null } }
check('空配置跟随默认', routeFor({slots:{overlap:{}}}, 'overlap', fakeCtx).followsDefault === true)
const rr = routeFor({slots:{overlap:{model:'m1',provider:'p1'}}}, 'overlap')
check('指定后不跟随', rr.followsDefault === false && rr.model === 'm1' && rr.provider === 'p1')

console.log('')
console.log('=== 5. 截断 ===')
const c = clip('A'.repeat(30000), 1000)
check('长文本被截断', c.length < 1100, c.length + ' 字符')
check('短文本不动', clip('abc', 1000) === 'abc')

console.log('')
console.log('=== 6. 错误服务 ===')
const badLlm = { async *stream(){ throw new Error('boom') } }
const r6 = await askModel(badLlm, { provider: 'test-provider', model: 'test-model' }, { prompt: 'x' })
check('异常被捕获不抛出', r6.ok === false && /模型调用失败/.test(r6.error), r6.error)

console.log('')
console.log('结果: PASS ' + pass + ' / FAIL ' + fail)
process.exitCode = fail ? 1 : 0
