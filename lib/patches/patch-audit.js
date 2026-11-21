import { checkAllPatches } from './patches.js'

export function auditPatchesOnBoot(root, options = {}) {
  const write = typeof options.write === "function" ? options.write : () => {}
  try {
    const { summary, results } = checkAllPatches(root)
    const lost = (results || [])
      .filter((r) => r.status !== "applied")
      .map((r) => ({
        id: (r.patch && r.patch.id) || "?",
        name: (r.patch && r.patch.name) || "",
        status: r.status,
        severity: (r.patch && r.patch.severity) || "unknown",
      }))

    if (!lost.length) {
      write("patch-audit-ok", `${summary.applied}/${summary.total} 在线`)
      return { ok: true, total: summary.total, applied: summary.applied, lost: [], message: null }
    }

    const lines = [
      `发现 ${lost.length} 个本地补丁已失效（共 ${summary.total} 个）：`,
      ...lost.map((x) => `  · ${x.id}${x.name ? "（" + x.name + "）" : ""} → ${x.status}`),
      "",
      "这些是你对插件源码做的小改动，作者的更新把它们覆盖掉了。",
      "重打方式：atlas_patch（先 dryRun 看会不会冲突），或让 AI 帮你重打。",
      "面板 → 概览页顶部也会显示这条红字提示。",
    ]
    const message = lines.join("\n")
    write("patch-audit-lost", lost.map((x) => x.id + "=" + x.status).join(" "))

    return {
      ok: false,
      total: summary.total,
      applied: summary.applied,
      lost,
      message,
    }
  } catch (error) {
    write("patch-audit-error", String((error && error.message) || error).slice(0, 160))
    return { ok: false, total: 0, applied: 0, lost: [], message: null }
  }
}

export function renderPatchAudit(audit) {
  if (audit.ok) return `=== 补丁自检 ===\n\n${audit.applied}/${audit.total} 个本地补丁全部在线。`
  if (!audit.message) return "=== 补丁自检 ===\n\n自检本身出错了，无法判断补丁状态。"
  return "=== 补丁自检 ===\n\n" + audit.message
}
