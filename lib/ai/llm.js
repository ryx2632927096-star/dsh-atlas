import { MODEL_SLOTS, normalizeModelConfig } from './models.js'

export const DEFAULT_TIMEOUT_MS = 45 * 1000

export const MAX_INPUT_CHARS = 24000

export function resolveLlm(ctx) {
  try {
    const get = ctx && ctx.get
    if (typeof get !== 'function') return null
    const llm = get.call(ctx, 'llm', false)
    return llm && typeof llm.stream === 'function' ? llm : null
  } catch {
    return null
  }
}

export function routeFor(resolved, slot, ctx) {
  const slots = (resolved && resolved.slots) || {}
  const cfg = normalizeModelConfig(slots[slot])
  let defaults = null
  if (cfg.followsDefault || !cfg.provider) {
    try {
      const service = ctx && typeof ctx.get === 'function'
        ? ctx.get('agentDefaultModel', false)
        : null
      defaults = service && typeof service.currentSelection === 'function'
        ? service.currentSelection()
        : null
    } catch {   }
    if (!defaults || typeof defaults !== 'object') {
      throw new Error(defaultRouteError(slot))
    }
  }
  const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : undefined
  const provider = text(cfg.provider) || text(defaults && defaults.provider)
  const model = text(cfg.model) || text(defaults && defaults.model)
  if (!provider || !model) throw new Error(defaultRouteError(slot))
  const reasoningEffort = text(cfg.reasoningEffort)
    || (cfg.followsDefault ? text(defaults && defaults.reasoningEffort) : undefined)
  return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}), followsDefault: cfg.followsDefault }
}

function defaultRouteError(slot) {
  return '无法解析 DSH 宿主当前默认模型。请先在 DSH 设置中选择默认模型，'
    + '或为 models.' + slot + ' 同时指定 provider 和 model；Atlas 不会猜测或回退到固定模型。'
}

export function clip(text, max = MAX_INPUT_CHARS) {
  const s = String(text == null ? '' : text)
  if (s.length <= max) return s
  const head = Math.floor(max * 0.6)
  const tail = max - head - 80
  return s.slice(0, head)
    + '\n\n…（中间省略 ' + (s.length - head - tail) + ' 字符）…\n\n'
    + s.slice(s.length - tail)
}

export function userMessage(text) {
  return {
    role: 'user',
    content: [{ type: 'text', text: String(text == null ? '' : text) }],
    source: { kind: 'user' },
  }
}

export async function askModel(llm, route, opts = {}) {
  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, error: '当前部署没有可用的 llm 服务（宿主没注入，或版本太老）' }
  }
  if (!route || typeof route.provider !== 'string' || !route.provider.trim()
    || typeof route.model !== 'string' || !route.model.trim()) {
    return { ok: false, error: '模型路由未解析：需要明确的 provider 和 model，请先读取 DSH 默认模型或完整指定模型。' }
  }
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => { try { controller.abort() } catch {   } }, timeoutMs)
  const merged = opts.signal
    ? AbortSignalAny([controller.signal, opts.signal])
    : controller.signal

  const request = {
    messages: [userMessage(clip(opts.prompt))],
    signal: merged,
  }
  if (opts.system) request.system = clip(opts.system)

  try {
    merged.throwIfAborted()
    const callOpts = { ...request, provider: route.provider, model: route.model }
    if (route.reasoningEffort) callOpts.reasoningEffort = route.reasoningEffort
    return await untilAborted((async () => {
      const stream = await llm.stream(callOpts)
      let reply = ''
      for await (const chunk of stream) {
        merged.throwIfAborted()
        if (chunk && chunk.type === 'text-delta') reply += chunk.text || ''
        else if (chunk && chunk.type === 'finish') {
          const reason = chunk.reason || {}
          if (reason.kind === 'error' || reason.kind === 'aborted') {
            const msg = (reason.failure && reason.failure.message) || reason.kind
            return { ok: false, error: '模型出错：' + msg }
          }
        }
      }
      if (!reply.trim()) return { ok: false, error: '模型返回空内容' }
      return { ok: true, text: reply.trim() }
    })(), merged)
  } catch (error) {
    if (opts.signal && opts.signal.aborted) return { ok: false, error: '模型调用已取消' }
    if (controller.signal.aborted) return { ok: false, error: '模型调用超时（' + Math.round(timeoutMs / 1000) + 's）' }
    return { ok: false, error: '模型调用失败：' + (error && error.message ? error.message : String(error)) }
  } finally {
    clearTimeout(timer)
  }
}

function untilAborted(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
    if (signal.aborted) onAbort()
  })
}

function AbortSignalAny(signals) {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') return AbortSignal.any(signals)
  } catch {   }
  const c = new AbortController()
  const onAbort = () => { try { c.abort() } catch {   } }
  for (const s of signals) {
    if (!s) continue
    if (s.aborted) { onAbort(); break }
    try { s.addEventListener('abort', onAbort, { once: true }) } catch {   }
  }
  return c.signal
}

export async function askJson(params) {
  let route
  try { route = routeFor(params.resolved, params.slot, params.ctx) }
  catch (error) { return { ok: false, error: error.message } }
  const system = [params.system || '', '', '只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块。'].join('\n').trim()
  const r = await askModel(params.llm, route, {
    system,
    prompt: params.prompt,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  })
  if (!r.ok) return { ...r, route }
  const parsed = parseJsonLoose(r.text)
  if (parsed === null) return { ok: false, error: '模型回复不是合法 JSON', text: r.text, route }
  return { ok: true, data: parsed, text: r.text, route }
}

export function parseJsonLoose(text) {
  let s = String(text == null ? '' : text).trim()
  if (!s) return null

  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(s)
  if (fence) s = fence[1].trim()

  try { return JSON.parse(s) } catch {   }

  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a !== -1 && b > a) {
    let body = s.slice(a, b + 1)
    body = body.replace(/,(\s*[}\]])/g, '$1')
    try { return JSON.parse(body) } catch {   }
  }
  return null
}

export function listSlots() {
  return Object.entries(MODEL_SLOTS).map(([key, desc]) => ({ key, desc }))
}
