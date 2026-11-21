import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from '../core/paths.js'

function probe(dir, depth = 2) {
  if (!existsSync(dir)) return { exists: false, files: 0, bytes: 0 }
  let files = 0
  let bytes = 0
  const walk = (d, lv) => {
    if (lv > depth) return
    let ents
    try { ents = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const f = join(d, e.name)
      if (e.isDirectory()) { walk(f, lv + 1); continue }
      files++
      try { bytes += statSync(f).size } catch {   }
    }
  }
  walk(dir, 0)
  return { exists: true, files, bytes }
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

function mnemonHome() {
  const home = dshHome()
  const a = join(home, '..', '.mnemon')
  if (existsSync(a)) return a
  const b = join(process.env.USERPROFILE || process.env.HOME || '', '.mnemon')
  return existsSync(b) ? b : null
}

export function collectSidebarEntries() {
  const home = dshHome()
  const mn = mnemonHome()
  const entries = []

  const memData = mn ? probe(join(mn, 'data')) : { exists: false, files: 0, bytes: 0 }
  const docData = mn ? probe(join(mn, 'documents')) : { exists: false, files: 0, bytes: 0 }
  const trailData = mn ? probe(join(mn, 'skills')) : { exists: false, files: 0, bytes: 0 }

  entries.push({
    label: '记忆系统',
    source: 'dsh-mnemon',
    what: 'AI 的长期记忆：记忆空间、项目文档、技能轨迹',
    content: memData.exists
      ? `记忆空间 ${memData.files} 个文件 · 文档 ${docData.files} 个 · 技能轨迹 ${trailData.files} 个`
      : '没找到数据目录',
    overlaps: '与「技能管理」是同一个插件加的两个入口',
    advice: '留着 —— 记忆能力本身，别的插件替不了',
    canClose: false,
  })

  entries.push({
    label: '技能管理',
    source: 'dsh-mnemon（和上面同一个插件）',
    what: '管理记忆里沉淀下来的技能轨迹，和「技能中心」不是一回事',
    content: trailData.exists ? `${trailData.files} 个文件` : '没有数据',
    overlaps: '名字和「技能中心」撞车，实际是 mnemon 的技能轨迹',
    advice: trailData.files > 0
      ? '有轨迹数据就留着；不用的话可以在 mnemon 设置里关掉这个入口（记忆功能不受影响）'
      : '没有数据，可以关掉这个入口',
    canClose: trailData.files === 0,
  })

  const skills = probe(join(home, 'skills'), 3)
  entries.push({
    label: '技能中心',
    source: '@linxin666/dsh-client-ui-skill-explorer',
    what: '浏览 ~/.dsh/skills 下的技能文件',
    content: skills.exists ? `${skills.files} 个文件` : '目录不存在',
    overlaps: '名字和「技能管理」撞车，但数据源完全不同（一个是文件，一个是记忆轨迹）',
    advice: skills.files > 0 ? '留着 —— 有实际技能在用' : '没有技能文件，可以关掉',
    canClose: skills.files === 0,
  })

  const ledger = readJson(join(home, 'task-board', 'ledger-v2.json'))
  const cards = Array.isArray(ledger && ledger.tasks) ? ledger.tasks.length : 0
  entries.push({
    label: '任务看板',
    source: '@linxin666/dsh-client-ui-task-board',
    what: '给 AI 派活、跟踪执行状态',
    content: cards ? `${cards} 张卡片` : '还没有卡片',
    overlaps: '无重叠',
    advice: '功能独立，按需保留',
    canClose: false,
  })

  const trend = probe(join(home, 'github-trending'), 1)
  entries.push({
    label: 'GitHub 趋势',
    source: '@morehao/dsh-github-trending',
    what: '每天抓 GitHub Trending 生成中文日报',
    content: trend.exists ? `${trend.files} 个文件 / ${Math.round(trend.bytes / 1024)} KB` : '没有产出',
    overlaps: '无重叠（独立功能）',
    advice: trend.files > 0 ? '留着 —— 有实际产出' : '没有产出，可以关掉',
    canClose: trend.files === 0,
  })

  entries.push({
    label: 'SSH',
    source: '@linxin666/dsh-ssh',
    what: '在 DSH 里连服务器执行命令',
    content: '独立能力',
    overlaps: '无重叠',
    advice: '按需保留',
    canClose: false,
  })

  entries.push({
    label: '上下文洞察',
    source: 'dsh-context',
    what: '看每次对话消耗多少 token、上下文怎么用的',
    content: '数据在宿主进程内，磁盘上没有副本',
    overlaps: '无重叠',
    advice: '按需保留',
    canClose: false,
  })

  entries.push({
    label: '插件',
    source: '宿主内置',
    what: '装 / 卸 / 更新插件 —— 唯一能改插件列表的地方',
    content: '宿主页',
    overlaps: '名字和「插件知枢」像，但职责不同：这里改，那里看',
    advice: '必留',
    canClose: false,
  })

  entries.push({
    label: '更多',
    source: '宿主内置',
    what: '把不常用的入口收进一个折叠菜单',
    content: '折叠容器',
    overlaps: '它本身就是「折叠」—— 你要的功能宿主已经有了',
    advice: '必留。想让侧栏少几项，把次要插件的入口收进这里',
    canClose: false,
  })

  entries.push({
    label: '插件知枢',
    source: 'dsh-atlas（本插件）',
    what: '看清装了什么、找重复、防改动被覆盖、每天查上游',
    content: '你正在看的这个',
    overlaps: '与「插件」互补：那边改，这边分析',
    advice: '留着',
    canClose: false,
  })

  return entries
}

export function summarizeSidebar(entries) {
  const list = Array.isArray(entries) ? entries : []
  return {
    total: list.length,
    canClose: list.filter((e) => e.canClose).length,
    essential: list.filter((e) => !e.canClose).length,
  }
}
