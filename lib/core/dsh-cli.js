import { existsSync } from 'node:fs'
import { join, extname, isAbsolute } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

export function findDshCli() {
  const roots = []
  if (process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness'))
  roots.push('/Applications/DeepSeek Harness.app/Contents', '/opt/DeepSeek Harness')
  const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe'] : ['dsh', 'dsh.js']
  for (const root of roots) for (const name of names) for (const dir of ['bin', '']) {
    const path = join(root, 'resources', 'runtime', 'cli', dir, name)
    if (existsSync(path)) return path
  }
  return null
}

export function cliInvocation(cli, args) {
  if (typeof cli !== 'string' || !isAbsolute(cli) || /[\x00-\x1f]/.test(cli)) throw new Error('CLI路径不合法')
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' || /[\x00-\x1f]/.test(a))) throw new Error('CLI参数不合法')
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cli)) {
    if ([cli, ...args].some((a) => /["%!^&|<>]/.test(a))) throw new Error('批处理路径/参数含shell控制字符')
    const command = '"' + [cli, ...args].map((a) => '"' + a + '"').join(' ') + '"'
    return { command: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/v:off', '/s', '/c', command], windowsVerbatimArguments: true }
  }
  if (/\.[cm]?js$/i.test(extname(cli))) return { command: process.execPath, args: [cli, ...args] }
  return { command: cli, args }
}

export function runDshCli(args, options = {}) {
  let invocation, cli
  try { cli = options.cli || findDshCli(); invocation = cliInvocation(cli, args) }
  catch (error) { return Promise.resolve({ status: null, error, stdout: '', stderr: '', quiescent: true }) }
  return new Promise((resolve) => {
    let stdout = '', stderr = '', timedOut = false, quiescent = true, spawnError, settled = false
    const child = spawn(invocation.command, invocation.args, {
      ...invocation, cwd: options.cwd,
      env: { ...(options.env || process.env), ...(/\.[cm]?js$/i.test(cli) ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
      shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    })
    const append = (which, chunk) => { if (which === 'out') stdout = (stdout + chunk).slice(-1024 * 1024); else stderr = (stderr + chunk).slice(-1024 * 1024) }
    child.stdout?.on('data', (c) => append('out', c)); child.stderr?.on('data', (c) => append('err', c))
    child.on('error', (error) => { spawnError = error })
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (!child.pid) return
        if (process.platform === 'win32') {
          const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 })
          if (killed.status !== 0) quiescent = false
        } else process.kill(-child.pid, 'SIGKILL')
      } catch { quiescent = false; child.kill() }
      if (!quiescent) {
        child.kill(); child.stdout?.destroy(); child.stderr?.destroy(); child.unref()
        finish(null)
      }
    }, options.timeoutMs ?? 300000)
    function finish(status) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const error = spawnError || (timedOut ? Object.assign(new Error('CLI执行超时'), { code: 'ETIMEDOUT' }) : undefined)
      resolve({ status, error, stdout, stderr, quiescent, timedOut })
    }
    child.on('close', finish)
  })
}

