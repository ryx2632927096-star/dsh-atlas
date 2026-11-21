import { resolveLlm } from '../lib/ai/llm.js'

let pass = 0, fail = 0
const check = (n, ok, d) => { if (ok) { pass++; console.log('  PASS ' + n + (d?'  ('+d+')':'')) } else { fail++; console.log('  FAIL ' + n + '  → ' + d) } }

console.log('=== resolveLlm 在各种 ctx 形状下的行为 ===')

check('ctx 为 null', resolveLlm(null) === null)
check('ctx 为 undefined', resolveLlm(undefined) === null)
check('ctx 是空对象', resolveLlm({}) === null)

check('get 不是函数', resolveLlm({ get: 'nope' }) === null)

check('get 抛错', resolveLlm({ get(){ throw new Error('x') } }) === null)

check('服务无 stream', resolveLlm({ get(){ return { foo: 1 } } }) === null)

const realLlm = { stream(){}, prepareCall(){} }
const got = resolveLlm({ get(name){ return name === 'llm' ? realLlm : null } })
check('拿到服务', got === realLlm)

let capturedArg = null
resolveLlm({ get(name, requireActive){ capturedArg = requireActive; return null } })
check('调用时要求 active=false（和 dsh-agents 一致）', capturedArg === false, '实际传了 ' + capturedArg)

console.log('')
console.log('结果: PASS ' + pass + ' / FAIL ' + fail)
process.exitCode = fail ? 1 : 0
