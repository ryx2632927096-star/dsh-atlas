import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const FAMILIES = [
  { key: "mcp", label: "MCP", test: (n) => n.startsWith("mcp__") || n.startsWith("ws_mcp") },
  { key: "memory", label: "记忆", test: (n) => /^mnemon_|memory|recall|remember/.test(n) },
  { key: "subagent", label: "子代理", test: (n) => /subagent|squad|agent/.test(n) },
  { key: "browser", label: "浏览器", test: (n) => n.startsWith("browser_") },
  { key: "desktop", label: "桌面", test: (n) => /^(screen_|app_|click|type|key|scroll)/.test(n) },
  { key: "taskboard", label: "任务看板", test: (n) => n.startsWith("task_board") || n === "team_comment" },
  { key: "atlas", label: "插件知枢", test: (n) => n.startsWith("atlas_") },
  { key: "host", label: "宿主内置", test: (n) => /^(pwsh|read|write|edit|glob|grep|run_code|job_|working_directory|load_workspace_dependencies|todo_write|skill|present|plan_|compact|set_|notify)/.test(n) },
  { key: "goal", label: "目标", test: (n) => /goal/.test(n) },
  { key: "remote", label: "远程", test: (n) => n.startsWith("remote_") },
  { key: "session", label: "会话", test: (n) => /^session_insights|^session_/.test(n) },
  { key: "trending", label: "趋势", test: (n) => /^trending_/.test(n) },
  { key: "ssh", label: "SSH", test: (n) => /^ssh_/.test(n) },
  { key: "market", label: "插件市场", test: (n) => /^(plugin_manager|market_)/.test(n) },
  { key: "meme", label: "表情", test: (n) => /meme/.test(n) },
]

export function familyOf(name) {
  for (const f of FAMILIES) {
    try { if (f.test(name)) return f.key } catch {   }
  }
  return "other"
}

export function familyLabel(key) {
  const hit = FAMILIES.filter((f) => f.key === key)[0]
  if (hit) return hit.label
  return key === "other" ? "其它" : key
}

export function groupByPlugin(surfaceRows, ownerByTool) {
  const rows = Array.isArray(surfaceRows) ? surfaceRows : []
  const owners = ownerByTool instanceof Map ? ownerByTool : new Map()
  const buckets = new Map()

  for (const r of rows) {
    const pluginId = owners.get(r.name) || null
    const key = pluginId || (isLikelyHostTool(r.name) ? "__host__" : "__unknown__")
    if (!buckets.has(key)) {
      buckets.set(key, { key, pluginId, tools: [], calls: 0, used: 0, unused: 0 })
    }
    const b = buckets.get(key)
    b.tools.push(r)
    b.calls += r.calls || 0
    if ((r.calls || 0) > 0) b.used += 1
    else b.unused += 1
  }

  const groups = []
  for (const b of buckets.values()) {
    const name = b.key === "__host__" ? "宿主内置（非插件）"
      : b.key === "__unknown__" ? "未归属"
      : b.pluginId
    groups.push({
      key: b.key,
      pluginId: b.pluginId,
      name,
      toolCount: b.tools.length,
      calls: b.calls,
      used: b.used,
      unused: b.unused,
      isHost: b.key === "__host__",
      isUnknown: b.key === "__unknown__",
      tools: b.tools.slice().sort((x, y) => (y.calls || 0) - (x.calls || 0)),
    })
  }

  groups.sort((a, b) => {
    if (a.isHost !== b.isHost) return a.isHost ? 1 : -1
    if (a.isUnknown !== b.isUnknown) return a.isUnknown ? 1 : -1
    return b.toolCount - a.toolCount
  })

  return {
    groups,
    summary: {
      groups: groups.length,
      plugins: groups.filter((g) => g.pluginId).length,
      host: groups.filter((g) => g.isHost).length,
      unknown: groups.filter((g) => g.isUnknown).length,
    },
  }
}

function isLikelyHostTool(name) {
  return /^(pwsh|bash|read|write|edit|glob|grep|run_code|job_|working_directory|load_workspace_dependencies|todo_write|skill|present|plan_|compact|set_|notify|ask_user_question|fact_register|get_goal|create_goal|update_goal|subagent|ralph|list_agents|interrupt_agent|send_message|tool_activate)/.test(name)
}
