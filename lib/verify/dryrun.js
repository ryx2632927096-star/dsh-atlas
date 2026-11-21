import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, readdirSync, copyFileSync } from "node:fs"
import { join, dirname, basename } from "node:path"
import { tmpdir } from "node:os"
import { randomBytes } from "node:crypto"
import { dshHome } from '../core/paths.js'
import { fingerprint, compare } from './session-guard.js'

export { findDshCli } from '../core/dsh-cli.js'
import { findDshCli, runDshCli } from '../core/dsh-cli.js'

export function treeFingerprint(dir, depth = 2) {
  let files = 0
  let bytes = 0
  let newest = 0
  const walk = (d, lv) => {
    if (lv > depth) return
    let ents
    try { ents = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const f = join(d, e.name)
      if (e.isDirectory()) { walk(f, lv + 1); continue }
      files++
      try { const st = statSync(f); bytes += st.size; if (st.mtimeMs > newest) newest = st.mtimeMs } catch {   }
    }
  }
  walk(dir, 0)
  return { files, bytes, newest }
}

export async function dryRun(options = {}) {
  const profileName = options.profileName || "desktop"
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30000
  const notes = []

  const cli = findDshCli()
  if (!cli) {
    return { ok: false, verdict: "unavailable", activated: 0, failedEntries: [], missingCredential: false, residual: false, notes, error: "找不到 dsh 启动器" }
  }

  const srcProfile = join(dshHome(), "profiles", profileName)
  if (!existsSync(srcProfile)) {
    return { ok: false, verdict: "unavailable", activated: 0, failedEntries: [], missingCredential: false, residual: false, notes, error: "找不到 profile：" + srcProfile }
  }

  const sessionsBefore = fingerprint()

  const lockFile = join(tmpdir(), "dsh-atlas-dryrun.lock")
  try {
    if (existsSync(lockFile)) {
      const st = statSync(lockFile)
      const age = Date.now() - st.mtimeMs
      if (age < 5 * 60 * 1000) {
        return {
          ok: false,
          verdict: "busy",
          notes: [`已有另一个隔离试运行正在跑（锁超过 ${Math.round(age / 1000)} 秒）`, "等它结束，或删掉锁文件：" + lockFile],
          residual: false,
          failedEntries: [],
        }
      }
      try { rmSync(lockFile, { force: true }) } catch {   }
    }
    writeFileSync(lockFile, String(process.pid), "utf8")
  } catch {   }

  const tmpRoot = join(tmpdir(), "dsh-atlas-dryrun")
  const tmpHome = join(tmpRoot, randomBytes(4).toString("hex"))
  const dstProfile = join(tmpHome, "profiles", "dryrun")
  let residual = false

  try {
    try { spawnSync("cmd", ["/c", "rmdir", "/s", "/q", tmpRoot], { timeout: 20000 }) } catch {   }
    mkdirSync(dstProfile, { recursive: true })

    const pkgSrc = join(srcProfile, "package.json")
    if (!existsSync(pkgSrc)) throw new Error("profile 里没有 package.json")
    const pkg = JSON.parse(readFileSync(pkgSrc, "utf8"))
    pkg.name = "dsh-profile-dryrun"

    const PORT_HOGS = [
      /^dshmarket$/,
      /\/dsh-client-ui-market$/,
      /^dsh-better-sidebar$/,
    ]
    const isPortHog = (name) => PORT_HOGS.some((re) => re.test(String(name)))
    const allBundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []
    const kept = allBundles.filter((b) => !isPortHog(b))
    const dropped = allBundles.filter((b) => isPortHog(b))
    if (pkg?.dsh?.profile) pkg.dsh.profile.bundles = kept
    if (dropped.length) {
      notes.push(`隔离实例跳过 ${dropped.length} 个会抢端口的插件：${dropped.join(", ")}`)
    }
    notes.push(`保留 ${kept.length}/${allBundles.length} 个 bundle（含 webServer 提供者，否则依赖它的插件会全 pending）`)

    writeFileSync(join(dstProfile, "package.json"), JSON.stringify(pkg, null, 2), "utf8")

    for (const f of ["cordis.patch.yml", "cordis.yml", "pnpm-workspace.yaml"]) {
      const s = join(srcProfile, f)
      if (existsSync(s)) { try { copyFileSync(s, join(dstProfile, f)) } catch {   } }
    }

    const srcNm = join(srcProfile, "node_modules")
    const dstNm = join(dstProfile, "node_modules")
    if (existsSync(srcNm)) {
      const r = spawnSync("cmd", ["/c", "mklink", "/J", dstNm, srcNm], { encoding: "utf8", timeout: 20000 })
      if (!existsSync(dstNm)) {
        notes.push("junction 建失败，改为不用 node_modules 跑（结果仅供参考）")
      } else {
        notes.push("node_modules 用 junction 链接，未复制内容")
      }
    }

    const before = existsSync(srcNm) ? treeFingerprint(srcNm, 1) : null

    const r = await runDshCli(["--profile", "dryrun"], {
      cli,
      encoding: "utf8",
      timeoutMs,
      env: {
        ...process.env,
        DSH_HOME: tmpHome,
        DSH_PROFILE: "dryrun",
        BROWSER: "none",
        PORT: "0",
        ELECTRON_NO_ATTACH_CONSOLE: "1",
      },
      cwd: tmpHome,
    })

    const out = String(r.stdout || "") + "\n" + String(r.stderr || "")
    const timedOut = Boolean(r.error && r.error.code === "ETIMEDOUT")
    if (timedOut) notes.push(`子进程到 ${Math.round(timeoutMs / 1000)}s 被结束 —— desktop app 不会自己退出，这是正常的，加载结果已在上面`)

    const HOST_PKG_RE = /Cannot find package '(@deepseek-ai\/[^']+|@earendil-works\/[^']+)'/
    const failedEntries = []
    const re = /^\s*([\w@/.\-]+) \(([^)]+)\): (.+)$/gm
    let m
    while ((m = re.exec(out)) !== null) {
      const reason = String(m[3]).slice(0, 200)
      const envLimited = HOST_PKG_RE.test(reason)
      failedEntries.push({ id: m[1], name: m[2], reason, envLimited })
    }
    const activatedMatch = /(\d+)\s+entry did not activate/i.exec(out)
    const notActivated = activatedMatch ? Number(activatedMatch[1]) : 0
    const missingCredential = /MISSING_CREDENTIAL/.test(out)

    if (before && existsSync(srcNm)) {
      const after = treeFingerprint(srcNm, 1)
      if (after.files !== before.files || after.bytes !== before.bytes) {
        notes.push(`⚠ 真实 node_modules 变了（文件 ${before.files}→${after.files}，字节 ${before.bytes}→${after.bytes}）`)
      } else {
        notes.push("真实 node_modules 未被改动（前后指纹一致）")
      }
    }

    const portConflict = /EADDRINUSE/.test(out)
    const errorLines = out.split("\n")
      .filter((l) => /^\s*error:/mi.test(l))
      .filter((l) => !/EADDRINUSE/.test(l))
    const hasStack = /\n\s+at\s+\S+\s+\(.*:\d+:\d+\)/.test(out) && !portConflict
    const hasHardError = errorLines.length > 0 || hasStack
    const realFailures = failedEntries.filter((f) => !f.envLimited)
    const envLimitedCount = failedEntries.length - realFailures.length

    let verdict = "unknown"
    if (timedOut && failedEntries.length === 0 && !portConflict) {
      verdict = "unknown"
      notes.push("超时且没抓到任何加载结果 —— 输出不完整，判不了。下次可以加大 timeoutMs。")
    } else if (realFailures.length > 0) {
      verdict = "fail"
    } else if (portConflict) {
      verdict = "environment-limited"
      notes.push("隔离实例没抢到端口（EADDRINUSE）——主实例已占用。这不是插件问题。")
      notes.push("插件加载阶段在报这个错之前就已经跑完了，上面的加载结论仍然有效。")
    } else if (envLimitedCount > 0) {
      verdict = "environment-limited"
      notes.push(`${envLimitedCount} 个插件因「宿主内置包不在 CLI 环境里」而没起来，`
        + "这不是插件的问题，但也说明本次试运行判断不了它们的好坏。")
      notes.push("要真正验证桌面版，只能在桌面版里 reload —— 那是另一回事。")
      notes.push("另外：这个 app 的启动行为不稳定（有时 6 秒退出、有时挂到超时），同一份配置两次结果可能不同。把这里的结论当参考，别当判决。")
    } else if (notActivated > 0) {
      verdict = "fail"
    } else if (hasHardError) {
      verdict = "unknown"
      notes.push("出现无法归类的错误输出，判不了。原始输出已保留，请人工看一眼。")
    } else {
      verdict = "pass"
    }

    const sessionsAfter = fingerprint()
    const sessionDelta = compare(sessionsBefore, sessionsAfter)
    if (!sessionDelta.same) {
      notes.push("⚠ 你的会话目录变了：" + sessionDelta.changes.join("，") + "（这不是本工具该做的事，请检查）")
    } else {
      notes.push("你的会话目录未被改动（" + sessionsAfter.files + " 个文件，指纹一致）")
    }

    return {
      ok: verdict === "pass",
      sessionDelta,
      verdict,
      diag: {
        sampleReasons: (failedEntries || []).slice(0, 2).map((f) => String(f.reason).slice(0, 140)),
        errorLines: errorLines.slice(0, 3).map((l) => String(l).slice(0, 120)),
        hasStack,
        notActivated,
        hasHardError,
        realFailures: realFailures.length,
        envLimited: envLimitedCount,
        missCred: missingCredential,
        outLength: out.length,
      },
      activated: notActivated,
      failedEntries,
      missingCredential,
      residual: false,
      notes,
      rawTail: out.split("\n").filter(Boolean).slice(-6).join("\n").slice(0, 800),
      rawLength: out.length,
    }
  } catch (error) {
    return { ok: false, verdict: "error", activated: 0, failedEntries: [], missingCredential: false, residual: false, notes, error: String((error && error.message) || error).slice(0, 200) }
  } finally {
    try { if (existsSync(lockFile)) rmSync(lockFile, { force: true }) } catch {   }
    let killedProcs = 0
    try {
      const tmpMarker = tmpRoot.replace(/\\/g, "/")
      const ps = spawnSync("cmd", ["/c",
        "powershell", "-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*" + tmpMarker + "*' -and $_.ProcessId -ne " + process.pid + " } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }",
      ], { timeout: 30000, encoding: "utf8" })
      const ids = String(ps.stdout || "").split(/\s+/).filter((x) => /^\d+$/.test(x))
      killedProcs = ids.length
      if (killedProcs > 0) {
        notes.push(`先结束了 ${killedProcs} 个还挂在临时目录上的子进程`)
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200) } catch {   }
      }
    } catch {   }

    let cleanupError = null
    try {
      const dstNm = join(dstProfile, "node_modules")
      if (existsSync(dstNm)) {
        const r1 = spawnSync("cmd", ["/c", "rmdir", dstNm], { timeout: 20000, encoding: "utf8" })
        if (existsSync(dstNm)) cleanupError = "junction 没删掉：" + String(r1.stderr || "").slice(0, 120)
      }
    } catch (e) { cleanupError = String(e.message).slice(0, 120) }

    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!existsSync(tmpRoot)) break
      spawnSync("cmd", ["/c", "rmdir", "/s", "/q", tmpRoot], { timeout: 30000 })
      if (!existsSync(tmpRoot)) break
      try { rmSync(tmpRoot, { recursive: true, force: true }) } catch (e) { cleanupError = String(e.message).slice(0, 120) }
      if (!existsSync(tmpRoot)) break
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800) } catch {   }
    }
    if (!existsSync(tmpRoot)) {
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600) } catch {   }
      if (existsSync(tmpRoot)) {
        spawnSync("cmd", ["/c", "rmdir", "/s", "/q", tmpRoot], { timeout: 20000 })
      }
    }
    if (existsSync(tmpRoot)) {
      spawnSync("cmd", ["/c", "rmdir", "/s", "/q", tmpRoot], { timeout: 20000 })
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400) } catch {   }
      spawnSync("cmd", ["/c", "rmdir", "/s", "/q", tmpRoot], { timeout: 20000 })
    }
    if (existsSync(tmpRoot)) {
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500) } catch {   }
      spawnSync("cmd", ["/c", "rmdir", "/s", "/q", tmpRoot], { timeout: 25000 })
    }
    residual = existsSync(tmpRoot)
    if (residual) {
      let leftFiles = 0
      try {
        const walk = (dir2, lv) => {
          if (lv > 4) return
          let ents = []
          try { ents = readdirSync(dir2, { withFileTypes: true }) } catch { return }
          for (const e of ents) {
            const q = join(dir2, e.name)
            if (e.isDirectory()) { walk(q, lv + 1); continue }
            leftFiles += 1
          }
        }
        walk(tmpRoot, 0)
      } catch {   }

      if (leftFiles > 0) {
        notes.push("⚠ 临时目录没删净（还有 " + leftFiles + " 个文件）：" + tmpRoot
          + (cleanupError ? "（" + cleanupError + "）" : ""))
        notes.push("下次运行会自动再清一遍；也可以手动：rmdir /s /q \"" + tmpRoot + "\"")
      } else {
        residual = false
        notes.push("临时目录内容已清空（只剩一个空壳，Windows 暂时锁着目录项）。")
        notes.push("关掉 DSH 后可以直接删：rmdir /s /q \"" + tmpRoot + "\"")
      }
    }
  }
}
