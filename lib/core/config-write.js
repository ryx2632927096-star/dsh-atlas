import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs"
import { join } from "node:path"
import { backupFile } from '../patches/auto-backup.js'

function patchPathOf(pkgDir) {
  return join(pkgDir, "cordis.patch.yml")
}

export function readModelsSection(pkgDir) {
  const file = patchPathOf(pkgDir)
  if (!existsSync(file)) return { found: false, text: null }
  let src
  try { src = readFileSync(file, "utf8") } catch { return { found: false, text: null } }
  const lines = src.split(/\r?\n/)
  const start = lines.findIndex((l) => /^\s*models:\s*$/.test(l))
  if (start < 0) return { found: false, text: null }
  const indent = (lines[start].match(/^\s*/) || [""])[0].length
  const out = [lines[start]]
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i]
    if (l.trim() === "") { out.push(l); continue }
    const ind = (l.match(/^\s*/) || [""])[0].length
    if (ind <= indent) break
    out.push(l)
  }
  return { found: true, text: out.join("\n") }
}

function safeValue(v) {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  if (!s) return null
  if (!/^[A-Za-z0-9@._/-]+$/.test(s)) return null
  return s
}

export function writeModelSlot(args) {
  const { pkgDir, slot } = args
  if (!pkgDir || !slot) return { ok: false, reason: "缺少 pkgDir 或 slot" }
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(slot)) return { ok: false, reason: "槽位名不合法：" + slot }

  const file = patchPathOf(pkgDir)
  if (!existsSync(file)) return { ok: false, reason: "找不到 " + file }
  const original = readFileSync(file, "utf8")
  const lines = original.split(/\r?\n/)

  const mStart = lines.findIndex((l) => /^\s*models:\s*$/.test(l))
  if (mStart < 0) return { ok: false, reason: "patch 里没有 models: 段" }
  const mIndent = (lines[mStart].match(/^\s*/) || [""])[0].length
  let mEnd = lines.length
  for (let i = mStart + 1; i < lines.length; i += 1) {
    const l = lines[i]
    if (l.trim() === "") continue
    const ind = (l.match(/^\s*/) || [""])[0].length
    if (ind <= mIndent) { mEnd = i; break }
  }

  const slotIndent = " ".repeat(mIndent + 2)
  const fieldIndent = " ".repeat(mIndent + 4)

  const provider = safeValue(args.provider)
  const model = safeValue(args.model)
  const effort = safeValue(args.reasoningEffort)
  const newBlock = []
  if (!model) {
    newBlock.push(slotIndent + slot + ": {}")
  } else {
    newBlock.push(slotIndent + slot + ":")
    if (provider) newBlock.push(fieldIndent + "provider: " + provider)
    newBlock.push(fieldIndent + "model: " + model)
    if (effort) newBlock.push(fieldIndent + "reasoningEffort: " + effort)
  }

  const slotRe = new RegExp("^" + " ".repeat(mIndent + 2) + slot + "\\s*:")
  const sIdx = (() => {
    for (let i = mStart + 1; i < mEnd; i += 1) if (slotRe.test(lines[i])) return i
    return -1
  })()

  let next
  if (sIdx >= 0) {
    let e = sIdx + 1
    while (e < mEnd) {
      const l = lines[e]
      if (l.trim() === "") { e += 1; continue }
      const ind = (l.match(/^\s*/) || [""])[0].length
      if (ind <= mIndent + 2) break
      e += 1
    }
    next = [...lines.slice(0, sIdx), ...newBlock, ...lines.slice(e)]
  } else {
    next = [...lines.slice(0, mEnd), ...newBlock, ...lines.slice(mEnd)]
  }

  const updated = next.join("\n")
  if (updated === original) return { ok: true, reason: "没有变化", before: original, after: updated }

  const bak = backupFile(file, { tag: "config" })
  if (!bak.ok) {
    return { ok: false, reason: "备份失败，为安全起见不写：" + (bak.reason || "未知原因") }
  }
  const backup = bak.backup

  try {
    writeFileSync(file, updated, "utf8")
  } catch (error) {
    return { ok: false, reason: "写入失败：" + String((error && error.message) || error), backup }
  }

  const check = readFileSync(file, "utf8")
  const okShape = /\n\s*models:\s*(\r?\n)/.test(check) && new RegExp("\\n" + " ".repeat(mIndent + 2) + slot + "\\s*:").test(check)
  if (!okShape) {
    try { copyFileSync(backup, file) } catch {   }
    return { ok: false, reason: "写后自检失败，已自动回滚", backup }
  }

  return { ok: true, backup, before: original, after: updated }
}
