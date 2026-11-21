import { SUPPORTED_V4 } from './paths.js'

const HUMAN_KINDS = new Set(['user'])

const HUMAN_ACTION_KINDS = new Set(['user-approval'])

const INJECTED_PREFIXES = [
  '<system-reminder>',
  'Current runtime context.',
  'Time sampled while preparing turn',
  'Available MCP servers (capability snapshot)',
  'A skill is a reusable set of task-specific instructions',
  'Instructions from:',
  'Session: 【当前时间】',
  '[dsh-mnemon:delegated skill]',
]

export function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block) continue
    if (typeof block === 'string') { parts.push(block); continue }
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

export function isInjected(data) {
  const kind = data?.source?.kind
  if (kind && !HUMAN_KINDS.has(kind) && !HUMAN_ACTION_KINDS.has(kind)) return true
  const text = contentToText(data?.content)
  const head = text.slice(0, 120)
  for (const prefix of INJECTED_PREFIXES) {
    if (head.startsWith(prefix)) return true
  }
  return false
}

function tryJson(text) {
  if (typeof text !== 'string' || !text) return null
  try { return JSON.parse(text) } catch { return null }
}

function argsSummary(argsText, limit = 200) {
  const parsed = tryJson(argsText)
  if (!parsed || typeof parsed !== 'object') {
    return String(argsText || '').slice(0, limit)
  }
  for (const key of ['description', 'command', 'query', 'prompt', 'path', 'file_path', 'name', 'tool']) {
    const value = parsed[key]
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, limit)
  }
  const first = Object.keys(parsed)[0]
  if (first && typeof parsed[first] === 'string') return parsed[first].slice(0, limit)
  return JSON.stringify(parsed).slice(0, limit)
}

export function argsShape(argsText) {
  let parsed
  try { parsed = JSON.parse(argsText) } catch { return '' }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ''

  const parts = []
  for (const [key, value] of Object.entries(parsed)) {
    if (value === null || value === undefined) { parts.push(`${key}:null`); continue }
    if (typeof value === 'string') {
      if (value.length <= 40) parts.push(`${key}="${value}"`)
      else parts.push(`${key}:string(${value.length})`)
      continue
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key}:${String(value).slice(0, 20)}`)
      continue
    }
    if (Array.isArray(value)) {
      parts.push(`${key}:array(${value.length})`)
      continue
    }
    if (typeof value === 'object') {
      parts.push(`${key}:object{${Object.keys(value).slice(0, 6).join('|')}}`)
      continue
    }
    parts.push(`${key}:${typeof value}`)
  }
  return parts.join(', ').slice(0, 400)
}

export function parseSessionText(text, options = {}) {
  const lines = String(text).split('\n')
  const events = []
  const stats = {
    records: 0,
    unsupported: 0,
    humanMessages: 0,
    injectedMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    errors: 0,
    unresolvedResults: 0,
    declaredTools: 0,
  }

  let header = null
  const declared = []
  const callNames = new Map()
  const callTimes = new Map()

  for (const raw of lines) {
    if (!raw || !raw.trim()) continue
    let record
    try { record = JSON.parse(raw) } catch { continue }

    if (record.type === 'session') {
      header = record
      if (record.version !== SUPPORTED_V4) {
        return {
          ok: false,
          reason: `unsupported session version ${record.version} (expected ${SUPPORTED_V4})`,
          header,
          events: [],
          stats,
        }
      }
      continue
    }

    if (!header) continue
    stats.records++

    const seq = typeof record.seq === 'number' ? record.seq : null
    const time = typeof record.time === 'number' ? record.time : null
    const type = record.type
    const data = record.data || {}

    if (type === 'tool/call') {
      const callId = data.callId || null
      const name = data.name || null
      if (callId && name) {
        callNames.set(callId, name)
        if (time) callTimes.set(callId, time)
      }
      stats.toolCalls++
      events.push({
        seq,
        time,
        type,
        tool: name,
        callId,
        summary: argsSummary(data.arguments),
        argShape: argsShape(data.arguments),
        isError: null,
        durationMs: null,
        textLen: 0,
      })
      continue
    }

    if (type === 'tool/result') {
      const message = data.message || {}
      const callId = message.toolCallId || data.toolCallId || null
      const tool = callId ? (callNames.get(callId) || null) : null
      const isError = message.isError === true
      const resultText = contentToText(message.content)
      let durationMs = null
      const startedAt = callId ? callTimes.get(callId) : null
      if (startedAt && time && time >= startedAt) durationMs = time - startedAt
      if (isError) stats.errors++
      if (callId && !tool) stats.unresolvedResults++
      stats.toolResults++
      events.push({
        seq,
        time,
        type,
        tool,
        callId,
        summary: resultText.slice(0, 240),
        argShape: '',
        isError,
        durationMs,
        textLen: resultText.length,
      })
      continue
    }

    if (type === 'tool/ptc-dispatch') {
      const name = typeof data?.name === 'string' && data.name ? data.name : null
      const isError = data?.isError === true
      const body = contentToText(data?.content)
      if (name) {
        stats.toolCalls++
        if (isError) stats.errors++
        const syntheticId = data?.subCallId || data?.rootCallId || null
        if (syntheticId) callNames.set(syntheticId, name)
        events.push({
          seq,
          time,
          type: 'tool/call',
          tool: name,
          callId: syntheticId,
          summary: argsSummary(JSON.stringify(data?.arguments || '')),
          argShape: argsShape(JSON.stringify(data?.arguments || '')),
          isError: null,
          durationMs: null,
          textLen: 0,
        })
      }
      const last = events[events.length - 1]
      if (last && last.type === 'tool/call' && last.tool === name) {
        last.isError = isError || null
        last.textLen = body.length
        if (body) last.resultSummary = body.slice(0, 200)
      }
      continue
    }

    if (type === 'request/header') {
      const list = data?.header?.tools
      if (Array.isArray(list)) {
        for (const t of list) {
          if (!t || typeof t.name !== 'string' || !t.name) continue
          declared.push({
            name: t.name,
            description: String(t.description || '').slice(0, 300),
            seq,
            time,
          })
        }
      }
      events.push({
        seq,
        time,
        type,
        tool: null,
        callId: null,
        summary: Array.isArray(list) ? `tools=${list.length}` : '',
        isError: null,
        durationMs: null,
        textLen: 0,
      })
      continue
    }

    if (type === 'user/message') {
      const injected = isInjected(data)
      const body = contentToText(data.content)
      if (injected) stats.injectedMessages++
      else stats.humanMessages++
      events.push({
        seq,
        time,
        type,
        tool: null,
        callId: null,
        summary: body.slice(0, 400),
        isError: null,
        durationMs: null,
        textLen: body.length,
        injected,
        sourceKind: data?.source?.kind ?? null,
        role: 'user',
      })
      continue
    }

    if (type === 'assistant/message') {
      const message = data.message || {}
      const body = contentToText(message.content)
      events.push({
        seq,
        time,
        type,
        tool: null,
        callId: null,
        summary: body.slice(0, 400),
        isError: null,
        durationMs: null,
        textLen: body.length,
        injected: false,
        role: 'assistant',
      })
      continue
    }

    events.push({
      seq,
      time,
      type,
      tool: null,
      callId: null,
      summary: '',
      isError: null,
      durationMs: null,
      textLen: 0,
    })
  }

  stats.declaredTools = new Set(declared.map((d) => d.name)).size
  return { ok: true, header, events, declared, stats, options }
}
