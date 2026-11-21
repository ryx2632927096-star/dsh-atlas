
export const MODEL_SLOTS = {
  overlap: "判断两个东西是不是在干同一件事",
  upstreamFix: "判断作者的更新是否已包含我的补丁",
  delegate: "派活给子会话时，那个会话用什么模型",
}

export function normalizeModelConfig(raw) {
  const empty = { provider: null, model: null, reasoningEffort: null, followsDefault: true }
  if (!raw || typeof raw !== "object") return empty

  const pick = (v) => (typeof v === "string" && v.trim() ? v.trim() : null)
  const provider = pick(raw.provider)
  const model = pick(raw.model)
  const reasoningEffort = pick(raw.reasoningEffort)

  if (!model) return { ...empty, reasoningEffort }

  return {
    provider,
    model,
    reasoningEffort,
    followsDefault: false,
  }
}

export function resolveModels(config) {
  const warnings = []
  const slots = {}
  const raw = config && typeof config === "object" ? config.models : null

  if (raw !== undefined && raw !== null && typeof raw !== "object") {
    warnings.push("config.models 不是对象，已按全部「跟随默认」处理")
  }

  for (const key of Object.keys(MODEL_SLOTS)) {
    const one = raw && typeof raw === "object" ? raw[key] : undefined
    const n = normalizeModelConfig(one)
    if (one && typeof one === "object" && !n.followsDefault && !n.model) {
      warnings.push(`models.${key} 缺少 model 字段，已按「跟随默认」处理`)
    }
    slots[key] = n
  }
  return { slots, warnings }
}

export function modelArgs(resolved, slot) {
  const s = resolved && resolved.slots ? resolved.slots[slot] : null
  if (!s || s.followsDefault || !s.model) return s?.reasoningEffort ? { reasoningEffort: s.reasoningEffort } : {}
  const out = { model: s.model }
  if (s.provider) out.provider = s.provider
  if (s.reasoningEffort) out.reasoningEffort = s.reasoningEffort
  return out
}

export function describeModels(resolved) {
  const lines = []
  for (const [key, desc] of Object.entries(MODEL_SLOTS)) {
    const s = resolved && resolved.slots ? resolved.slots[key] : null
    const value = !s || s.followsDefault
      ? "跟随默认模型" + (s?.reasoningEffort ? "（推理强度：" + s.reasoningEffort + "）" : "")
      : (s.provider ? s.provider + "/" : "") + s.model + (s.reasoningEffort ? "（" + s.reasoningEffort + "）" : "")
    lines.push(`${key}: ${value}  — ${desc}`)
  }
  return lines.join("\n")
}
