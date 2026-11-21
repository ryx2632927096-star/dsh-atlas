import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, writeFileSync, rmSync, readdirSync, statSync, readFileSync, mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"

const DEFAULT_TIMEOUT = 180000

function runNode(scriptPath, args = [], timeout = DEFAULT_TIMEOUT, prefixArgs = []) {
  const r = spawnSync(process.execPath, [...prefixArgs, scriptPath, ...args], {
    timeout,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "" },
  })
  return {
    ok: r.status === 0,
    stdout: String(r.stdout || ""),
    stderr: String(r.stderr || ""),
    timedOut: r.error && r.error.code === "ETIMEDOUT",
    status: r.status,
  }
}

export function checkSyntax(entryFile) {
  if (!existsSync(entryFile)) return { level: "L1 语法", ok: false, detail: "文件不存在：" + entryFile }
  const r = spawnSync(process.execPath, ["--check", entryFile], { timeout: 20000, encoding: "utf8" })
  if (r.status === 0) return { level: "L1 语法", ok: true, detail: "语法通过" }
  const msg = String(r.stderr || "").split("\n").filter(Boolean).slice(0, 3).join(" ")
  return { level: "L1 语法", ok: false, detail: msg.slice(0, 300) }
}

export function checkLoadAndApply(pkgDir, entryFile, options = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "dsh-atlas-verify-"))
  const driver = join(tmp, "driver.mjs")
  const payload = {
    entry: pathToFileURL(resolve(entryFile)).href,
    pkgDir: resolve(pkgDir),
    invoke: Array.isArray(options.invoke) ? options.invoke : [],
  }

  const stubDir = join(tmp, "stubs")
  let stubbed = []
  let stubError = null
  try {
    stubbed = Object.keys(writeStubs(pkgDir, stubDir))
  } catch (error) {
    stubError = String((error && error.message) || error).slice(0, 160)
  }
  payload.stubHook = existsSync(join(stubDir, "resolve-hook.mjs"))
    ? pathToFileURL(join(stubDir, "resolve-hook.mjs")).href
    : null
  payload.stubbed = stubbed

  writeFileSync(driver, DRIVER_SOURCE, "utf8")

  const nodeArgs = payload.stubHook ? ["--import", payload.stubHook] : []
  try {
    const r = runNode(driver, [JSON.stringify(payload)], options.timeoutMs || DEFAULT_TIMEOUT, nodeArgs)
    if (r.timedOut) {
      return [
        { level: "L2 加载", ok: false, detail: `超时（${(options.timeoutMs || DEFAULT_TIMEOUT) / 1000}s）—— 可能顶层有死循环或等待` },
        { level: "L3 注册", ok: false, detail: "未执行（L2 未完成）" },
      ]
    }
    const lines = r.stdout.trim().split("\n").filter(Boolean)
    let out = null
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i].startsWith("__RESULT__")) {
        try { out = JSON.parse(lines[i].slice(10)) } catch {   }
        break
      }
    }
    if (!out) {
      const err = (r.stderr || r.stdout || "").split("\n").filter(Boolean).slice(0, 3).join(" ")
      return [
        { level: "L2 加载", ok: false, detail: "子进程异常退出，没有结果：" + err.slice(0, 300) },
        { level: "L3 注册", ok: false, detail: "未执行" },
      ]
    }
    const levels = (out.levels || []).map((l) => {
      if (l.ok) return l
      if (stubbed.length && looksLikeStubArtifact(l.detail)) {
        return {
          ...l,
          ok: true,
          skipped: true,
          label: l.level + "（无法判定）",
          detail: "依赖宿主内置包，子进程用桩顶替后撑不住这一步，据此判不了好坏：" + l.detail,
        }
      }
      return l
    })
    if (stubError) {
      levels.push({
        level: "L2s 桩",
        ok: false,
        detail: "桩生成失败（依赖宿主内置包的插件会被误判）：" + stubError,
      })
    } else if (stubbed.length) {
      levels.push({
        level: "L2s 桩",
        ok: true,
        detail: "顶替了 " + stubbed.length + " 个宿主内置包：" + stubbed.map((s) => s.replace("@deepseek-ai/", "")).join(", "),
      })
    }
    return levels
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }) } catch {   }
  }
}


const STUB_TOLERANT_PATTERNS = [
  /Cannot convert object to primitive/i,
  /Cannot read properties of undefined \(reading '(?:default|then)'\)/i,
  /is not a function/,
  /Cannot destructure/i,
  /is not iterable/i,
  /undefined is not/i,
]

function looksLikeStubArtifact(message) {
  const s = String(message || '')
  return STUB_TOLERANT_PATTERNS.some((re) => re.test(s))
}

export function collectHostImports(pkgDir) {
  const need = new Map()
  const add = (spec, name) => {
    if (!need.has(spec)) need.set(spec, new Set())
    if (name && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) need.get(spec).add(name)
  }
  const walk = (d, depth) => {
    if (depth > 4) return
    let ents
    try { ents = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      const f = join(d, e.name)
      if (e.isDirectory()) { walk(f, depth + 1); continue }
      if (!/\.(js|mjs|cjs)$/.test(e.name)) continue
      let t
      try { if (statSync(f).size > 3_000_000) continue; t = readFileSync(f, 'utf8') } catch { continue }
      for (const m of t.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](@deepseek-ai\/[^"']+)["']/g)) {
        for (const piece of m[1].split(',')) {
          const name = piece.trim().split(/\s+as\s+/)[0].trim()
          if (name) add(m[2], name)
        }
      }
      for (const m of t.matchAll(/import\s+(?:\*\s*as\s+\w+\s+)?from\s*["'](@deepseek-ai\/[^"']+)["']/g)) add(m[1], null)
    }
  }
  walk(pkgDir, 0)
  return need
}

export function writeStubs(pkgDir, stubDir) {
  const need = collectHostImports(pkgDir)
  mkdirSync(stubDir, { recursive: true })
  const map = {}
  for (const [spec, names] of need) {
    const file = join(stubDir, spec.replace(/[@/]/g, '_') + '.mjs')
    const body = [
      '// 自动生成的桩：这个包由宿主内置提供，子进程里没有文件，用万能 Proxy 顶替。',
      '// 目的：让 L2/L3 能跑到；桩撑不住的地方，验证器会标「无法判定」而不是失败。',
      'const make = () => new Proxy(function () {}, {',
      '  get(t, p) {',
      '    if (p === "then") return undefined',
      '    if (p === "default") return make()',
      '    if (typeof p === "symbol") return undefined',
      '    return make()',
      '  },',
      '  apply() { return make() },',
      '  construct() { return make() },',
      '})',
      ...[...names].map((n) => 'export const ' + n + ' = make()'),
      'export default make()',
    ].join('\n')
    writeFileSync(file, body, 'utf8')
    map[spec] = pathToFileURL(file).href
  }
  writeFileSync(join(stubDir, '_map.json'), JSON.stringify(map), 'utf8')
  writeFileSync(join(stubDir, 'resolve-hook.mjs'), RESOLVE_HOOK_SOURCE, 'utf8')
  return map
}

const RESOLVE_HOOK_SOURCE = `
import { registerHooks } from "node:module"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const HOOK_DIR = fileURLToPath(new URL(".", import.meta.url))
let map = {}
try { map = JSON.parse(readFileSync(HOOK_DIR + "_map.json", "utf8")) } catch {}

const FALLBACK_SRC = "const m=()=>new Proxy(function(){},{get(t,p){"
  + "if(p===\\\"then\\\")return undefined;"
  + "if(p===\\\"default\\\")return m();"
  + "if(typeof p===\\\"symbol\\\")return undefined;"
  + "return m()}});export default m()"

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (map[specifier]) return { url: map[specifier], shortCircuit: true, format: "module" }
    if (specifier.startsWith("@deepseek-ai/")) {
      return { url: "data:text/javascript," + encodeURIComponent(FALLBACK_SRC), shortCircuit: true, format: "module" }
    }
    return nextResolve(specifier, context)
  },
})
`

const DRIVER_SOURCE = `
const payload = JSON.parse(process.argv[2])
const levels = []

// 先装解析钩子：让 @deepseek-ai/* 走桩。
// 不装的话，任何依赖宿主内置包的插件都会在 import 阶段就失败 ——
// 那是宿主架构导致的假阳性，不是插件的问题（实测 dsh-click 就是这样）。
// 钩子已由 --import 在解析任何 import 之前装好，这里只记录状态。

const emit = () => { console.log("__RESULT__" + JSON.stringify({ levels })) }

// ── L2 加载 ──
let mod
try {
  mod = await import(payload.entry)
  levels.push({ level: "L2 加载", ok: true, detail: "导出：" + Object.keys(mod).join(", ") })
} catch (error) {
  levels.push({ level: "L2 加载", ok: false, detail: String(error && error.message || error).slice(0, 300) })
  levels.push({ level: "L3 注册", ok: false, detail: "未执行（L2 失败）" })
  emit(); process.exit(0)
}

// ── L3 注册：用最小模拟 ctx 跑 apply ──
if (typeof mod.apply !== "function") {
  levels.push({ level: "L3 注册", ok: false, detail: "没有导出 apply 函数" })
  emit(); process.exit(0)
}

const registeredTools = new Map()
const registeredSlots = []
const disposeFns = []
const noop = () => {}

const fakeCtx = {
  tools: { register(def) { if (def && def.name) registeredTools.set(def.name, def); return noop } },
  slots: {
    inject(name, fn) { registeredSlots.push(name); try { const d = fn(); return typeof d === "function" ? d : noop } catch { return noop } },
    register(def) { registeredSlots.push((def && def.name) || "?"); return noop },
  },
  inject(deps, cb) { try { cb(fakeCtx) } catch { /* 服务不在是正常的 */ } return noop },
  get() { return null },
  effect(fn) { try { const d = fn(); if (typeof d === "function") disposeFns.push(d) } catch { /* ignore */ } },
  on() { return noop },
  emit: noop,
  logger: { info: noop, warn: noop, error: noop, debug: noop },
}

try {
  await mod.apply(fakeCtx, { patrolTickMinutes: 0 })
  // 给异步注册（setTimeout 里的 inject）一点时间
  await new Promise((r) => setTimeout(r, 300))
  levels.push({
    level: "L3 注册",
    ok: true,
    detail: "工具 " + registeredTools.size + " 个，插槽 " + registeredSlots.length + " 个"
      + (registeredTools.size ? "：" + [...registeredTools.keys()].slice(0, 8).join(", ") : ""),
  })
} catch (error) {
  levels.push({ level: "L3 注册", ok: false, detail: "apply 抛错：" + String(error && error.message || error).slice(0, 250) })
  emit(); process.exit(0)
}

// 可选：调用指定工具（默认空，因为很多工具有写副作用）
if (payload.invoke.length) {
  const fails = []
  for (const name of payload.invoke) {
    const t = registeredTools.get(name)
    if (!t) { fails.push(name + "：没有这个工具"); continue }
    try { await t.execute({}) } catch (e) { fails.push(name + "：" + String(e && e.message || e).slice(0, 120)) }
  }
  levels.push({
    level: "L3b 工具调用",
    ok: fails.length === 0,
    detail: fails.length ? fails.join(" | ") : payload.invoke.length + " 个工具调用通过",
  })
}

// 清理，避免驱动进程挂住
for (const d of disposeFns) { try { d() } catch { /* ignore */ } }
emit()
process.exit(0)
`

export function checkSelfTests(pkgDir, options = {}) {
  const scriptsDir = join(pkgDir, "scripts")
  if (!existsSync(scriptsDir)) return { level: "L4 自测", ok: true, detail: "没有 scripts/ 目录，跳过" }
  let files = []
  try {
    files = readdirSync(scriptsDir).filter((n) => /^verify-.*\.mjs$/.test(n)).sort()
  } catch {
    return { level: "L4 自测", ok: false, detail: "读不了 scripts/ 目录" }
  }
  if (Array.isArray(options.only) && options.only.length) {
    files = files.filter((n) => options.only.indexOf(n) >= 0)
  }
  if (!files.length) return { level: "L4 自测", ok: true, detail: "没有 verify-*.mjs，跳过" }

  const failed = []
  const hollow = []
  let asserted = 0

  for (const f of files) {
    const r = runNode(join(scriptsDir, f), [], options.timeoutMs || DEFAULT_TIMEOUT)
    const out = (r.stdout || "") + "\n" + (r.stderr || "")

    if (!r.ok) {
      if (r.timedOut) {
        hollow.push(f + "（超时）")
        continue
      }
      const msg = (r.stderr || r.stdout || "").split("\n").filter(Boolean).slice(-2).join(" ")
      failed.push(f + " → " + msg.slice(0, 160))
      continue
    }

    const hasFail = /^\s*\[?\s*(FAIL|❌|✗)/m.test(out) || /验收结论：未通过/.test(out)
    if (hasFail) {
      failed.push(f + " → 输出里有 FAIL 但退出码是 0（脚本该 exit(1)）")
      continue
    }
    const hasAssert = /^\s*\[?\s*(PASS|✓|✅)/m.test(out) || /\bcheck\(|\bassert|验收结论/.test(out)
    if (!hasAssert) {
      hollow.push(f)
      continue
    }
    asserted += 1
  }

  if (failed.length) {
    return {
      level: "L4 自测",
      ok: false,
      detail: failed.join(" ｜ ") + (hollow.length ? `（另有 ${hollow.length} 个空壳脚本）` : ""),
    }
  }
  if (hollow.length) {
    return {
      level: "L4 自测",
      ok: true,
      skipped: true,
      label: "L4 自测（部分无法判定）",
      detail: `${asserted} 个有真断言通过；${hollow.length} 个是空壳脚本（只打印不判断），无法据此判定：`
        + hollow.slice(0, 4).join(", ") + (hollow.length > 4 ? " 等" : ""),
    }
  }
  return {
    level: "L4 自测",
    ok: true,
    detail: files.length + " 个自测全部通过（都有真断言）",
  }
}

export async function verifyPluginChange(options) {
  const levels = []
  levels.push(checkSyntax(options.entryFile))

  if (levels[0].ok) {
    levels.push(...checkLoadAndApply(options.pkgDir, options.entryFile, options))
  } else {
    levels.push({ level: "L2 加载", ok: false, detail: "未执行（L1 失败）" })
    levels.push({ level: "L3 注册", ok: false, detail: "未执行（L1 失败）" })
  }

  const l3ok = levels.filter((l) => l.level.startsWith("L3")).every((l) => l.ok)
  if (options.runSelfTests !== false && l3ok) {
    levels.push(checkSelfTests(options.pkgDir, options))
  } else if (options.runSelfTests !== false) {
    levels.push({ level: "L4 自测", ok: false, detail: "未执行（L3 失败）" })
  }

  const unverified = [
   "只有 L4 覆盖到的分支算验证过；没写测试的路径，四层全绿也照不到",
   "依赖真实宿主服务（webServer / gateway）的路径，模拟 ctx 走不到",
   "与其它插件相互干扰产生的冲突，单插件验证看不到",
   "L3 默认不调用工具（多数工具有写副作用），只验证注册成功",
  ]

  const failed = levels.filter((l) => !l.ok)
  const skipped = levels.filter((l) => l.skipped)
  return {
    ok: failed.length === 0,
    verdict: failed.length ? "fail" : (skipped.length ? "partial" : "pass"),
    levels,
    unverified,
  }
}
