import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

export function findHostAsar() {
  const env = process.env.DSH_APP_ASAR
  if (env && existsSync(env)) return env

  const resPath = process.resourcesPath
  if (typeof resPath === "string" && resPath) {
    const p = join(resPath, "app.asar")
    if (existsSync(p)) return p
  }

  const candidates = []
  if (typeof process.execPath === "string") {
    candidates.push(resolve(process.execPath, "..", "resources", "app.asar"))
    candidates.push(resolve(process.execPath, "..", "..", "Resources", "app.asar"))
  }

  const appName = process.env.DSH_APP_NAME || "DeepSeek Harness"
  const localAppData = process.env.LOCALAPPDATA
  if (localAppData) {
    candidates.push(join(localAppData, "Programs", appName, "resources", "app.asar"))
  }
  candidates.push("/Applications/" + appName + ".app/Contents/Resources/app.asar")
  candidates.push("/opt/" + appName + "/resources/app.asar")

  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

export function readAsarHeader(asarPath) {
  try {
    const fd = readFileSync(asarPath)
    const headerSize = fd.readUInt32LE(12)
    if (headerSize <= 0 || headerSize > 32 * 1024 * 1024) return null
    return JSON.parse(fd.slice(16, 16 + headerSize).toString("utf8"))
  } catch {
    return null
  }
}

export function listBuiltinPlugins() {
  const asar = findHostAsar()
  const empty = { builtin: [], counts: { total: 0, plugins: 0, libraries: 0 }, asar: null }
  if (!asar) return { ...empty, error: "找不到宿主 app.asar（可用 DSH_APP_ASAR 指定）" }

  const header = readAsarHeader(asar)
  if (!header) return { ...empty, asar, error: "asar header 解析失败" }

  const dshNode = header.files && header.files.dsh && header.files.dsh.files
  const nm = dshNode && dshNode.node_modules
  const ds = nm && nm.files && nm.files["@deepseek-ai"]
  if (!ds || !ds.files) return { ...empty, asar, error: "找不到 dsh/node_modules/@deepseek-ai" }

  const names = Object.keys(ds.files)
  const builtin = []
  let plugins = 0
  let libraries = 0

  for (const name of names.sort()) {
    const node = ds.files[name]
    if (!node || !node.files) continue
    const hasLib = Boolean(node.files.lib)
    const hasSrc = Boolean(node.files.src)
    const hasPkg = Boolean(node.files["package.json"])
    if (!hasPkg && !hasLib && !hasSrc) continue

    const isFramework = /^cordis(-plugin)?-/.test(name) || name === "cordis" || name === "cosmokit" || name === "schemastery"
    const isLibrary = isFramework || /(-types$|^dsh-types$)/.test(name)

    if (isLibrary) libraries++
    else plugins++

    builtin.push({
      id: "@deepseek-ai/" + name,
      shortName: name,
      kind: isLibrary ? "library" : "plugin",
      hasLib,
      hasSrc,
      sourceType: "builtin",
    })
  }

  return { builtin, counts: { total: builtin.length, plugins, libraries }, asar }
}
