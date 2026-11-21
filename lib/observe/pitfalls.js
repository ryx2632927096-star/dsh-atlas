
export const CATEGORIES = [
  {
    id: 'mcp-whitelist',
    name: 'MCP 工具不在白名单',
    re: /不在 QQ 桥接白名单内|已拒绝/,
    cause: '请求的工具未获当前桥接策略放行。',
    fix: '在桥接配置中核对受信任的服务器标识与工具权限。',
    verify: '确认请求来自预期服务器，并检查管理员批准的权限范围。',
    severity: 'high',
  },
  {
    id: 'mcp-enum',
    name: '参数枚举值非法',
    re: /Invalid option: expected one of/,
    cause: '调用远端工具前没核对 schema，传了枚举外的值（如 mode 只能 diving/active）。',
    fix: '先 ws_mcp_detail 查 schema 再 ws_mcp_call；枚举字段照抄 allowed 值。',
    verify: '看报错里的 expected one of 列表，逐字对照。',
    severity: 'medium',
  },
  {
    id: 'mcp-precondition',
    name: '前置条件未满足（沉睡观察）',
    re: /还不能立刻设置潜水|还不能通过.*直接回到潜水|还需等待约/,
    cause: 'QQ 桥接要求潜水/收尾前必须先完成一次 5 分钟沉睡观察，' +
      '直接调用 set_wake_config / mark_read 会被拒。',
    fix: '先 qq_wait_for_messages(timeoutMs=300000) 完成观察，再设置潜水或标记已读。',
    verify: '看返回里 preSleepWaitSatisfied 是否为 true。',
    severity: 'medium',
  },
  {
    id: 'mcp-token',
    name: 'agent token 无效',
    re: /agent token 无效/,
    cause: '二代仿真模式（reserved2）下调用发送类工具必须携带会话令牌 token，' +
      'token 来自 qq_read / qq_get_context_snapshot 的返回。',
    fix: '先用 qq_read 拿 token，再调发送工具并带上 token。',
    verify: 'qq_get_prompt 可查当前模式的令牌要求。',
    severity: 'high',
  },
  {
    id: 'mcp-input',
    name: 'MCP 参数缺失或类型错',
    re: /Invalid input|expected string, received undefined|expected object, received undefined|Invalid arguments/,
    cause: '调用时漏了必填字段，或字段类型不对。',
    fix: '先 ws_mcp_detail 看 inputSchema 的 required 列表，再组装参数。',
    verify: '按 required 逐项核对。',
    severity: 'medium',
  },
  {
    id: 'mcp-watermark',
    name: 'readThroughSeq 水位非法',
    re: /throughSeq 必须是不超过/,
    cause: 'mark_read 的 throughSeq 必须是「已展示连续消息水位」，不能自己编。',
    fix: '用 qq_read / qq_get_unread_messages 返回的 readThroughSeq，不要手填。',
    verify: '看返回里是否有可用的 readThroughSeq。',
    severity: 'low',
  },
  {
    id: 'mcp-server-missing',
    name: 'MCP server 未连接或名字不对',
    re: /server 未连接或未发现|server .* 未连接或连接失败|server 参数格式非法|不属于当前工作空间/,
    cause: 'server 参数有三种常见错法：用了内部随机 id、' +
      '格式不对（缺 @root/ 前缀）、或用了别的 workspace 的 root。',
    fix: 'server 必须写成 @<root>/<server>，且 root 是当前工作空间；名字一律从 ws_mcp_list 抄。',
    verify: 'ws_mcp_list 里显示的「外部名」才可用。',
    severity: 'medium',
  },
  {
    id: 'net-redirect',
    name: '跨域重定向未跟随',
    re: /cross-origin redirect to .* is not followed automatically/,
    cause: 'web_fetch 出于安全不自动跟随跨域重定向，需要显式指定最终 URL。',
    fix: '按提示里的目标 URL 直接再请求一次。',
    verify: '第二次请求用报错里给出的地址。',
    severity: 'low',
  },
  {
    id: 'net-fail',
    name: '网络请求失败/超时',
    re: /fetch failed|timed out after|unsupported content type/,
    cause: '目标站点不可达、响应过慢，或返回了不认识的内容类型。',
    fix: '换源或改用 web_search；超时类可考虑缩短范围重试。',
    verify: '对同一 URL 用 web_search 交叉验证是否站点本身有问题。',
    severity: 'low',
  },
  {
    id: 'stale-observation',
    name: '桌面观察已过期（截图/操作被拒）',
    re: /changed since observation|no longer matches observation/,
    cause: 'dsh-click 的动作要求基于新鲜观察：拿 observationId 后窗口像素/无障碍树变了，' +
      '动作会被拒绝。这是防止误点的护栏。',
    fix: '重新 screen_shot / screen_read 拿新的 observationId，再基于它操作。',
    verify: '每次操作前重新观察，不要复用旧 id。',
    severity: 'medium',
  },
  {
    id: 'window-gone',
    name: '目标窗口已消失',
    re: /no visible window owned by process|no longer matches observation.*title\/class/,
    cause: '要操作的窗口已关闭或换了进程。',
    fix: '重新 app_list 确认窗口还在，再重新观察。',
    verify: 'app_list 里能看到目标窗口。',
    severity: 'low',
  },
  {
    id: 'unknown-tool',
    name: '工具不存在（工具表已变）',
    re: /unknown tool "/,
    cause: '调用了当前会话里未注册的工具，通常是插件被禁用/卸载后旧提示词还在。',
    fix: '用 ws_mcp_list 或工具清单确认可用工具，不要凭记忆调。',
    verify: '确认该工具在当前工具表里。',
    severity: 'medium',
  },
  {
    id: 'safety-net',
    name: '安全网拦截（危险操作）',
    re: /BLOCKED by CC Safety Net/,
    cause: 'cc-safety-net 拦下了范围过大的破坏性命令（如 cwd 外的 Remove-Item -Recurse）。',
    fix: '缩小目标到明确路径，或先问用户再提权。这是护栏在正常工作，不要绕过。',
    verify: '命令的目标路径是否精确到具体文件。',
    severity: 'low',
  },
  {
    id: 'edit-anchor',
    name: '编辑锚点未命中',
    re: /old_string was not found/,
    cause: '要替换的文本不存在（文件已变、或原文记忆有误）。',
    fix: '先 read 目标区域，用实际内容做锚点。',
    verify: 'read 出确切文本再 edit。',
    severity: 'low',
  },
  {
    id: 'arg-missing',
    name: '必填参数缺失（宿主层）',
    re: /missing required property/i,
    cause: '工具调用缺必填参数，宿主在入口就拒了。',
    fix: '按工具 schema 补全必填项。',
    verify: '对照工具参数定义。',
    severity: 'low',
  },
  {
    id: 'path-guard',
    name: '路径守卫拒绝',
    re: /source path must stay inside the workspace|out of range for/,
    cause: '文件操作超出了允许范围（工作区外，或 offset 超过文件长度）。',
    fix: '路径限制在工作区内；读文件先确认行数再用 offset。',
    verify: '目标路径在工作区下；offset 小于文件行数。',
    severity: 'low',
  },
  {
    id: 'interrupted',
    name: '调用被中断',
    re: /interrupted after it was recorded/,
    cause: '工具调用发出后宿主重启或会话中断，结果未落盘。',
    fix: '先核实外部状态再决定是否重试，不要盲目重放有副作用的操作。',
    verify: '检查操作的实际结果是否已产生。',
    severity: 'low',
  },
  {
    id: 'user-cancel',
    name: '用户取消',
    re: /the user cancelled ask_user_question/,
    cause: '用户主动关掉提问框，属于正常交互，不是错误。',
    fix: '不要重复追问同一件事；换个方式或跳过。',
    verify: '—',
    severity: 'info',
  },
  {
    id: 'invalid-args-schema',
    name: '参数含未知字段',
    re: /INVALID_ARGUMENTS: arguments has unknown property/,
    cause: '多传了 schema 里没定义的字段。',
    fix: '只传 schema 声明的字段，多余的去电。',
    verify: '对照 schema 的 properties。',
    severity: 'low',
  },
  {
    id: 'required-field',
    name: '返回对象缺必填字段',
    re: /result\.\w+ is required|is not an allowed value|Source Action is not offered/,
    cause: '构造的返回/提交对象不符合 schema（缺字段、枚举非法、或该动作当前 View 不支持）。',
    fix: '按返回 schema 补齐字段；动作类先确认当前 View 提供了哪些 Action。',
    verify: '对照 schema 的 required 与 View 提供的 action 列表。',
    severity: 'medium',
  },
  {
    id: 'run-code-trap',
    name: 'run_code 里出现被拦截或被拦截的操作',
    re: /code run failed \(exception\)/,
    cause: 'run_code 中的代码抛了异常，且宿主只回传异常文本。' +
      '实测高频原因：在 run_code 里调了被安全网/插件限制的操作，或访问 undefined 的属性。',
    fix: '把 run_code 拆小、逐步验证；涉及文件/命令的操作优先用专用工具而非在代码里绕。',
    verify: '看异常类型（ToolCallError = 被下游工具拒；TypeError = 自己的代码 bug）。',
    severity: 'low',
  },
  {
    id: 'browser-ownership',
    name: '浏览器标签不属于当前会话',
    re: /was not opened by this session/,
    cause: '浏览器插件只允许关闭/操作本会话打开的标签，避免误关别人的页面。',
    fix: '只操作 browser_tabs 里属于本会话的 tab；别人的标签不要碰。',
    verify: 'browser_tabs 的归属字段。',
    severity: 'low',
  },
  {
    id: 'tool-timeout',
    name: '工具响应超时',
    re: /did not respond within \d+ms/,
    cause: '工具在内部超时窗口内没返回（常见于记忆/向量类后端卡住）。',
    fix: '先确认后端在线（如 Ollama 11434）；缩小请求范围后重试，别连着重发。',
    verify: '对应后端的探活接口。',
    severity: 'medium',
  },
]

export const KNOWN_LESSONS = [
  {
    id: 'pnpm-hardlink',
    name: 'pnpm 硬链接：原地写会污染全局 store',
    severity: 'high',
    trigger: '直接编辑 profile/node_modules 下的文件（尤其 lib/*.js）',
    cause: 'pnpm 用硬链接共享文件：profile 里的文件和 AppData/Local/pnpm/store 里的'
      + '是同一个 inode。原地写入会同时改掉全局 store，影响所有用到该包的 profile/项目。',
    fix: '先备份 → 删除 profile 侧文件（断链）→ 把改好的新文件放进去。'
      + '绝不原地写。改完用 fsutil hardlink list 复查 links==1。',
    verify: 'fsutil hardlink list <file>  # 结果应只有 1 条',
  },
  {
    id: 'dsn-restart-kills-child',
    name: 'DSH 重启会连带杀掉挂在工具进程树下的子进程',
    severity: 'medium',
    trigger: '宿主退出后，其托管子进程也可能退出。',
    cause: '子进程的生命周期取决于启动方式。',
    fix: '检查应用的进程管理配置。',
    verify: '重新检查服务可用性。',
  },
  {
    id: 'tool-result-no-name',
    name: 'tool/result 不带工具名，必须回连 callId',
    severity: 'medium',
    trigger: '解析会话记录做统计',
    cause: 'tool/result 记录里只有 toolCallId，没有工具名。直接按工具名分组会把错误全部归到 null。',
    fix: '先扫一遍 tool/call 建 callId → name 映射，再用 tool/result 的 callId 回连。',
    verify: '统计里「未回连」数量应为 0（atlas_summary 会显示 unresolvedResults）。',
  },
  {
    id: 'user-message-injection',
    name: 'user/message 里混入大量系统注入',
    severity: 'medium',
    trigger: '统计「用户说了什么」',
    cause: 'user/message 里除了真人输入，还有 time-context、runtime-context、'
      + 'agent-instructions、system-reminder、MCP 快照、skill 目录等多种注入，占多数。',
    fix: '按 source.kind 白名单（只有 "user" 算真人）+ 内容前缀双重过滤。',
    verify: '使用合成记录核对真人输入和系统注入的计数。',
  },
]
export function classify(text) {
  const s = String(text || '')
  for (const c of CATEGORIES) if (c.re.test(s)) return c
  return null
}

export function expandPaths(text, surfcoreDir) {
  const s = String(text || '')
  if (!surfcoreDir) return s
  return s.split('<surfcore>').join(surfcoreDir)
}

export function buildPitfalls(db) {
  const rows = db.prepare(`
    SELECT tool, summary, time, session_id
    FROM events WHERE type='tool/result' AND is_error=1
    ORDER BY time DESC
  `).all()

  const buckets = new Map()
  let matched = 0
  const unmatchedSamples = []

  for (const row of rows) {
    const cat = classify(row.summary)
    const tool = row.tool || '(unknown)'
    if (!cat) {
      if (unmatchedSamples.length < 8) unmatchedSamples.push({ tool, text: String(row.summary || '').slice(0, 160) })
      continue
    }
    matched++
    if (!buckets.has(cat.id)) {
      buckets.set(cat.id, {
        id: cat.id,
        name: cat.name,
        cause: cat.cause,
        fix: cat.fix,
        verify: cat.verify,
        severity: cat.severity,
        count: 0,
        tools: new Map(),
        samples: [],
        lastAt: null,
      })
    }
    const b = buckets.get(cat.id)
    b.count++
    b.tools.set(tool, (b.tools.get(tool) || 0) + 1)
    if (b.samples.length < 3) b.samples.push({ tool, text: String(row.summary || '').replace(/\s+/g, ' ').slice(0, 180) })
    if (row.time && (!b.lastAt || row.time > b.lastAt)) b.lastAt = row.time
  }

  const order = { high: 0, medium: 1, low: 2, info: 3 }
  const list = [...buckets.values()]
    .map((b) => ({ ...b, tools: Object.fromEntries(b.tools) }))
    .sort((a, b) => (order[a.severity] - order[b.severity]) || (b.count - a.count))

  return {
    total: rows.length,
    matched,
    unmatched: rows.length - matched,
    unmatchedSamples,
    buckets: list,
    knownLessons: KNOWN_LESSONS,
  }
}

export function renderPitfalls(report, options = {}) {
  const onlySeverity = options.severity || null
  const limit = options.limit || 20
  const lines = []

  lines.push('=== 踩坑库 ===')
  lines.push(`报错总数 ${report.total}｜已归类 ${report.matched}｜未归类 ${report.unmatched}`)
  lines.push('')

  const list = onlySeverity
    ? report.buckets.filter((b) => b.severity === onlySeverity)
    : report.buckets

  for (const b of list.slice(0, limit)) {
    lines.push(`[${b.severity}] ${b.name}  ×${b.count}`)
    lines.push(`  涉及工具：${Object.entries(b.tools).map(([t, n]) => `${t}(${n})`).join(', ')}`)
    lines.push(`  根因：${b.cause}`)
    lines.push(`  正确做法：${b.fix}`)
    if (b.verify && b.verify !== '—') lines.push(`  怎么验证：${b.verify}`)
    if (b.samples.length) {
      lines.push(`  样例：${b.samples[0].text.slice(0, 120)}`)
    }
    lines.push('')
  }

  if (report.unmatchedSamples.length) {
    lines.push(`未归类样本（前 ${report.unmatchedSamples.length} 条，可据此补规则）：`)
    for (const s of report.unmatchedSamples) {
      lines.push(`  [${s.tool}] ${s.text.replace(/\s+/g, ' ').slice(0, 130)}`)
    }
    lines.push('')
  }

  const known = report.knownLessons || []
  const knownFiltered = onlySeverity ? known.filter((k) => k.severity === onlySeverity) : known
  if (knownFiltered.length) {
    lines.push(`=== 已知历史坑（${knownFiltered.length} 条，不来自报错聚类）===`)
    lines.push('')
    for (const k of knownFiltered) {
      lines.push(`[${k.severity}] ${k.name}`)
      lines.push(`  触发条件：${k.trigger}`)
      lines.push(`  根因：${k.cause}`)
      lines.push(`  正确做法：${k.fix}`)
      lines.push(`  怎么验证：${k.verify}`)
      lines.push('')
    }
  }

  return lines.join('\n')
}
