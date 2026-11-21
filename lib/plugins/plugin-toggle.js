import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { dshHome } from '../core/paths.js'

function marketPatchModule(profileName = "desktop") {
  const p = join(dshHome(), "profiles", profileName, "node_modules", "dshmarket", "lib", "patch.js")
  return existsSync(p) ? p : null
}

export async function loadMarketPatchApi(profileName = "desktop") {
  const file = marketPatchModule(profileName)
  if (!file) return null
  try {
    const mod = await import(pathToFileURL(file).href)
    const need = ["findUserPatchPath", "readUserPatchState", "disableRow", "enableRow"]
    if (!need.every((k) => typeof mod[k] === "function")) return null
    return { mod, source: file }
  } catch {
    return null
  }
}

export function locatePatchFile(ctx, profileName = "desktop") {
  const profileDir = join(dshHome(), "profiles", profileName)
  const conventional = join(profileDir, "cordis.patch.yml")
  if (existsSync(conventional)) return conventional
  return null
}

export function readToggleState({ patchFile, rowId, api }) {
  if (!patchFile || !existsSync(patchFile)) return { known: false, disabled: false, reason: "找不到补丁层文件" }
  try {
    if (api && typeof api.readUserPatchState === "function") {
      const st = api.readUserPatchState(patchFile) || {}
      const arr = Array.isArray(st.disables) ? st.disables : []
      const forced = Array.isArray(st.forced) ? st.forced : []
      if (forced.indexOf(rowId) >= 0 && arr.indexOf(rowId) < 0) {
        return { known: true, disabled: false, note: "被显式强制启用" }
      }
      return { known: true, disabled: arr.indexOf(rowId) >= 0 }
    }
    const text = readFileSync(patchFile, "utf8")
    const re = new RegExp("- id: " + rowId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\\s\\S]{0,400}?disabled:\\s*true")
    return { known: true, disabled: re.test(text) }
  } catch (error) {
    return { known: false, disabled: false, reason: String((error && error.message) || error) }
  }
}

export async function setPluginEnabled({ patchFile, rowId, api, disable, expectedName }) {
  if (!patchFile) return { ok: false, via: "none", reason: "找不到补丁层文件" }
  if (!/^[A-Za-z0-9@._/-]+$/.test(String(rowId || ""))) {
    return { ok: false, via: "none", reason: "行 id 含不支持的字符：" + rowId }
  }

  if (api) {
    try {
      const fn = disable ? api.disableRow : api.enableRow
      if (typeof fn === "function") {
        const r = await fn(patchFile, rowId, expectedName ? { expectedName } : {})
        return { ok: Boolean(r && r.ok !== false), via: "dshmarket", reason: r && r.reason }
      }
    } catch (error) {
      return { ok: false, via: "dshmarket", reason: String((error && error.message) || error) }
    }
  }

  return { ok: false, via: "none", reason: "没有可用的写入实现（未装 dshmarket，且回退实现未启用）" }
}
