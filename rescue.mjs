#!/usr/bin/env node
import * as syncFs from "node:fs"
import { existsSync, readdirSync, readFileSync, copyFileSync, statSync, writeFileSync } from "node:fs"
import { join, basename } from "node:path"
import { homedir } from "node:os"
import { plainPath, contained, digest } from "./lib/core/safe-tree.js"

function findBundledNode() {
  const rel = ["resources", "runtime", "primary-runtime", "dependencies", "node", "bin"]
  const roots = []
  if (process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, "Programs", "DeepSeek Harness"))
  roots.push("/Applications/DeepSeek Harness.app/Contents")
  roots.push("/opt/DeepSeek Harness")
  for (const r of roots) {
    const p = join(r, ...rel, "node.exe")
    if (existsSync(p)) return p
    const p2 = join(r, ...rel, "node")
    if (existsSync(p2)) return p2
  }
  return null
}
function dshHome() {
  const env = process.env.DSH_HOME
  if (env && env.trim()) return env.trim()
  return join(homedir(), ".dsh")
}

function profileDir(profileName = "desktop") {
  return join(dshHome(), "profiles", profileName)
}

function human(bytes) {
  if (bytes < 1024) return bytes + " B"
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB"
  return (bytes / 1024 / 1024).toFixed(1) + " MB"
}

async function loadYaml(dir) {
  const cands = [
    join(dir, "node_modules", "js-yaml"),
    "js-yaml",
  ]
  for (const c of cands) {
    try {
      const mod = await import(c.startsWith("/") || /^[A-Za-z]:/.test(c) ? "file:///" + c.replace(/\\/g, "/") + "/index.js" : c)
      const yaml = mod.default || mod
      if (typeof yaml.load === "function") return yaml
    } catch {   }
  }
  return null
}

export async function check(profileName = "desktop") {
  const dir = profileDir(profileName)
  const problems = []
  const info = []

  if (!existsSync(dir)) {
    return { ok: false, problems: ["找不到 profile 目录：" + dir], info }
  }

  const pkgFile = join(dir, "package.json")
  let pkg = null
  if (!existsSync(pkgFile)) {
    problems.push("package.json 不存在")
  } else {
    try {
      pkg = JSON.parse(readFileSync(pkgFile, "utf8"))
      const deps = Object.keys(pkg.dependencies || {}).length
      const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || []
      info.push("package.json 合法：dependencies " + deps + " 条，bundles " + bundles.length + " 条")

      const nm = join(dir, "node_modules")
      const missing = bundles.filter((b) => {
        if (typeof b !== "string") return false
        if (b.startsWith("@deepseek-ai/")) return false
        return !existsSync(join(nm, b))
      })
      if (missing.length) {
        problems.push("bundles 里有 " + missing.length + " 个包在 node_modules 找不到（常见于卸载残留）：" + missing.slice(0, 5).join(", "))
      }
    } catch (error) {
      problems.push("package.json 不是合法 JSON：" + String(error.message).slice(0, 120))
    }
  }

  const patchFile = join(dir, "cordis.patch.yml")
  if (!existsSync(patchFile)) {
    info.push("cordis.patch.yml 不存在（正常，说明没改过插件配置）")
  } else {
    const yaml = await loadYaml(dir)
    if (!yaml) {
      info.push("找不到 yaml 解析器，跳过 cordis.patch.yml 校验")
    } else {
      try {
        const doc = yaml.load(readFileSync(patchFile, "utf8"))
        const n = Array.isArray(doc) ? doc.length : 0
        info.push("cordis.patch.yml 合法：" + n + " 个顶层条目")
        const dupInSameBlock = []
        const scanBlock = (rows) => {
          if (!Array.isArray(rows)) return
          const seen = new Set()
          for (const row of rows) {
            if (!row || typeof row !== "object" || typeof row.id !== "string") continue
            if (seen.has(row.id)) dupInSameBlock.push(row.id)
            seen.add(row.id)
          }
        }
        if (Array.isArray(doc)) {
          for (const entry of doc) {
            if (entry && Array.isArray(entry.insert)) scanBlock(entry.insert)
          }
        }
        if (dupInSameBlock.length) {
          problems.push("cordis.patch.yml 里同一个 insert 块内 id 重复（会导致加载失败）：" + [...new Set(dupInSameBlock)].join(", "))
        }
      } catch (error) {
        problems.push("cordis.patch.yml 解析失败：" + String(error.message).slice(0, 140))
      }
    }
  }

  const baks = listBackups(profileName)
  info.push("可用备份 " + baks.length + " 份")
  if (!baks.length) {
    problems.push("没有任何备份 —— 出问题时无法回滚。建议先跑一次 node rescue.mjs backup")
  }

  return { ok: problems.length === 0, problems, info }
}

export function listBackups(profileName = "desktop") {
  const dir = profileDir(profileName)
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((n) => /\.bak([-.].*)?$/.test(n))
      .map((n) => {
        const full = join(dir, n)
        let size = 0, mtime = 0
        try { const st = statSync(full); size = st.size; mtime = st.mtimeMs } catch {   }
        return { name: n, path: full, size, mtime, target: n.replace(/\.bak([-.].*)?$/, "") }
      })
      .sort((a, b) => b.mtime - a.mtime)
  } catch {
    return []
  }
}

export function backup(profileName = "desktop") {
  const dir = profileDir(profileName)
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const made = []
  for (const name of ["package.json", "cordis.patch.yml"]) {
    const src = join(dir, name)
    if (!existsSync(src)) continue
    const dst = src + ".bak-rescue-" + stamp
    copyFileSync(src, dst)
    made.push(basename(dst))
  }
  return made
}

export function restore(backupName, profileName = "desktop") {
  let safety
  try {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profileName)) throw new Error('profile名不合法')
    if (typeof backupName !== 'string' || !/^(package\.json|cordis\.patch\.yml|cordis\.yml)\.bak[-.][A-Za-z0-9._-]+$/.test(backupName)) throw new Error('备份名不合法')
    const dir = plainPath(profileDir(profileName))
    const src = plainPath(contained(dir, join(dir, backupName)))
    const target = plainPath(contained(dir, join(dir, backupName.replace(/\.bak([-.].*)?$/, ''))))
    if (!existsSync(src) || !existsSync(target)) throw new Error('备份或当前目标不存在')
    safety = target + '.bak-before-restore-' + new Date().toISOString().replace(/[:.]/g, '-')
    plainPath(safety)
    copyFileSync(target, safety)
    if (digest(target) !== digest(safety)) throw new Error('当前文件保护副本校验失败')
    const tmp = target + '.restore-' + process.pid + '-' + Date.now()
    copyFileSync(src, tmp)
    if (digest(src) !== digest(tmp)) throw new Error('待恢复文件校验失败')
    const { renameSync } = syncFs
    renameSync(tmp, target)
    if (digest(target) !== digest(src)) throw new Error('恢复后内容不一致')
    return { ok: true, restored: basename(target), safetyCopy: basename(safety) }
  } catch (error) { return { ok: false, reason: error.message, safetyCopy: safety && basename(safety) } }
}

export function safeMode(profileName = "desktop") {
  const dir = profileDir(profileName)
  const pkgFile = join(dir, "package.json")
  if (!existsSync(pkgFile)) return { ok: false, reason: "package.json 不存在" }
  const bak = backup(profileName)
  let pkg
  try { pkg = JSON.parse(readFileSync(pkgFile, "utf8")) } catch (e) { return { ok: false, reason: "package.json 解析失败：" + e.message } }

  const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || []
  const keep = bundles.filter((b) => typeof b === "string" && b.startsWith("@deepseek-ai/"))
  if (!keep.length) return { ok: false, reason: "bundles 里没有任何宿主基础包，不敢动" }

  pkg.dsh.profile.bundles = keep
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n", "utf8")
  return { ok: true, kept: keep.length, removed: bundles.length - keep.length, backups: bak }
}

const isMain = process.argv[1] && /rescue\.mjs$/.test(process.argv[1])
if (isMain) {
  const raw = process.argv[2]
  const cmd = (!raw ? "check" : String(raw).replace(/^--?/, "")).toLowerCase()
  const arg = process.argv[3]
  const run = async () => {
    if (cmd === "check") {
      const r = await check()
      console.log("=== DSH profile 体检 ===")
      for (const i of r.info) console.log("  ✓ " + i)
      for (const p of r.problems) console.log("  ✗ " + p)
      console.log("")
      console.log(r.ok ? "结论：没发现问题，DSH 打不开多半不是配置问题。" : "结论：发现 " + r.problems.length + " 个问题，上面带 ✗ 的行就是。")
      process.exitCode = r.ok ? 0 : 1
      return
    }
    if (cmd === "list") {
      const list = listBackups()
      if (!list.length) { console.log("没有备份。"); return }
      console.log("可回滚的备份（新的在前）：")
      for (const b of list) {
        console.log("  " + new Date(b.mtime).toLocaleString("zh-CN") + "  " + human(b.size).padStart(9) + "  " + b.name)
      }
      console.log("")
      console.log("恢复某个：node rescue.mjs restore <上面某个名字>")
      return
    }
    if (cmd === "backup") {
      const made = backup()
      console.log(made.length ? "已备份：" + made.join(", ") : "没有可备份的文件")
      return
    }
    if (cmd === "restore") {
      if (!arg) { console.log("用法：node rescue.mjs restore <备份文件名>"); process.exitCode = 1; return }
      const r = restore(arg)
      console.log(r.ok ? "已恢复 " + r.restored + "（恢复前的现状另存为 " + r.safetyCopy + "）" : "失败：" + r.reason)
      process.exitCode = r.ok ? 0 : 1
      return
    }
    if (cmd === "sessions-backup") {
      const g = await import("./lib/verify/session-guard.js")
      const before = g.fingerprint()
      const r = g.backup({ keep: 3 })
      if (!r.ok) { console.log("失败：" + r.reason); process.exitCode = 1; return }
      console.log("已备份 " + r.files + " 个文件 / " + Math.round(r.bytes / 1024 / 1024) + "MB")
      console.log("位置：" + r.dir)
      if (r.pruned && r.pruned.length) console.log("清理旧备份：" + r.pruned.join(", "))
      const after = g.fingerprint()
      const c = g.compare(before, after)
      console.log(c.same ? "原目录未改动（前后指纹一致）" : "⚠ 原目录变了：" + c.changes.join("，"))
      return
    }
    if (cmd === "sessions-list") {
      const g = await import("./lib/verify/session-guard.js")
      const list = g.listBackups()
      if (!list.length) { console.log("没有会话备份。跑一次 sessions-backup 就有了。"); return }
      console.log("会话备份（新的在前）：")
      for (const x of list) {
        console.log("  " + new Date(x.mtime).toLocaleString("zh-CN") + "  " + x.files + " 文件  " + Math.round(x.bytes / 1024 / 1024) + "MB  " + x.name)
      }
      return
    }
    if (cmd === "sessions-restore") {
      if (!arg) { console.log("用法：node rescue.mjs sessions-restore <备份名>"); process.exitCode = 1; return }
      const g = await import("./lib/verify/session-guard.js")
      const r = g.restore(arg)
      console.log(r.ok ? "已恢复 " + r.files + " 个文件（只新增/覆盖，不删除现有会话）" : "失败：" + r.reason)
      if (r.safetyBackup) console.log("恢复前保护副本：" + r.safetyBackup)
      if (r.partial) console.log("部分恢复：" + r.files + " 个文件；请保留保护副本")
      process.exitCode = r.ok ? 0 : 1
      return
    }

    if (cmd === "safe") {
      const r = safeMode()
      if (!r.ok) { console.log("失败：" + r.reason); process.exitCode = 1; return }
      console.log("已进入安全态：保留 " + r.kept + " 个宿主基础 bundle，移除 " + r.removed + " 个。")
      console.log("原配置已备份：" + r.backups.join(", "))
      console.log("现在启动 DSH 应该能起来。确认能开后，再用 node rescue.mjs restore <备份> 逐步找回。")
      return
    }
    console.log("用法：")
    console.log("  node rescue.mjs check          体检")
    console.log("  node rescue.mjs list           列出备份")
    console.log("  node rescue.mjs backup         现在存一份备份")
    console.log("  node rescue.mjs restore <名字>  恢复某个备份")
    console.log("  node rescue.mjs safe           一键进安全态（几乎停用所有插件）")
    console.log("  node rescue.mjs sessions-backup   备份会话记录")
    console.log("  node rescue.mjs sessions-list     列出会话备份")
    console.log("  node rescue.mjs sessions-restore <名字>  恢复会话备份")
    const bundled = findBundledNode()
    if (bundled && !/\\nodejs\\node\.exe$/i.test(process.execPath)) {
      console.log("")
      console.log("没有 node 的话，用 DSH 自带这个（不需要另装）：")
      console.log("  \"" + bundled + "\" rescue.mjs check")
    }
  }
  run().catch((e) => { console.error("出错：", e.message); process.exitCode = 1 })
}
