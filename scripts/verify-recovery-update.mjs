import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join, dirname, basename, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { backup, listBackups, restore } from '../lib/verify/session-guard.js'
import { tree, verifyTree, cloneTree } from '../lib/core/safe-tree.js'
import { updatePlugins, loadDependencies, backupPlugins, restorePlugins, isUpdatableSpec, updateBackupRoot } from '../lib/update/update.js'
import { captureProfile, linkPolicy } from '../lib/update/profile-transaction.js'
import { runDshCli, cliInvocation } from '../lib/core/dsh-cli.js'
import { backupBeforeWrite, withBackup } from '../lib/patches/auto-backup.js'

const sourceRoot = fileURLToPath(new URL('..', import.meta.url))
const suite = fs.mkdtempSync(join(process.env.ATLAS_TEST_ROOT || tmpdir(), 'atlas-recovery-'))
const put = (file, text) => { fs.mkdirSync(dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
const json = (file, value) => put(file, JSON.stringify(value))
const read = (file) => fs.readFileSync(file, 'utf8')
function fixture() {
  const root = fs.mkdtempSync(join(suite, 'case-'))
  const home = join(root, 'home'), data = join(root, 'data'), dir = join(home, 'profiles', 'test')
  Object.assign(process.env, { DSH_HOME: home, DSH_ATLAS_HOME: data, DSH_PROFILE: 'test', DSH_PROFILE_DIR: dir,
    DSH_SESSIONS_ROOT: join(home, 'sessions'), SNOWLUMA_HOME: join(root, 'snowluma'), LOCALAPPDATA: join(root, 'local') })
  const nm = join(dir, 'node_modules')
  json(join(dir, 'package.json'), { dependencies: { 'dsh-a': '^1.0.0', 'dsh-b': '1.0.0' }, dsh: { profile: { bundles: ['dsh-a'] } } })
  put(join(dir, 'pnpm-lock.yaml'), 'lock: old\n'); put(join(dir, 'cordis.yml'), 'config:\n  entries: []\n')
  json(join(dir, 'compatibility.json'), { prior: true })
  json(join(nm, 'dsh-a', 'package.json'), { name: 'dsh-a', version: '1.0.0' })
  json(join(nm, 'dsh-b', 'package.json'), { name: 'dsh-b', version: '1.0.0' })
  put(join(nm, 'dsh-b', 'transitive.txt'), 'old transitive')
  put(join(home, 'sessions', 'a'), 'synthetic old A'); put(join(home, 'sessions', 'b'), 'synthetic old B')
  const launcher = join(root, 'launcher space 中文.mjs')
  put(launcher, `import fs from 'node:fs'; import {join,resolve,sep} from 'node:path';
const dir=process.env.DSH_PROFILE_DIR, nm=join(dir,'node_modules'), mode=process.env.ATLAS_FAKE_MODE;
fs.writeFileSync(join(dir,'argv.json'),JSON.stringify(process.argv.slice(2)));
if(process.env.npm_config_ignore_scripts!=='true') throw new Error('scripts enabled');
const pkg=JSON.parse(fs.readFileSync(join(dir,'package.json'),'utf8'));pkg.dependencies['dsh-a']='2.0.0';fs.writeFileSync(join(dir,'package.json'),JSON.stringify(pkg));
fs.writeFileSync(join(dir,'pnpm-lock.yaml'),'lock: new');fs.writeFileSync(join(dir,'pnpm-workspace.yaml'),'new: true');fs.writeFileSync(join(dir,'cordis.yml'),'config: {entries: [changed]}');
fs.writeFileSync(join(dir,'compatibility.json'),'{"prior":false}');
fs.writeFileSync(join(nm,'dsh-a','package.json'),JSON.stringify({name:'dsh-a',version:mode==='invalid'?'': '2.0.0'}));
fs.writeFileSync(join(nm,'dsh-b','transitive.txt'),'new transitive');fs.mkdirSync(join(nm,'added'));fs.writeFileSync(join(nm,'added','new'),'new');
if(mode==='remove'){if(!resolve(nm).startsWith(resolve(process.env.ATLAS_FAKE_ROOT)+sep))throw Error('unsafe removal');fs.rmSync(nm,{recursive:true});}
if(mode==='corrupt-backup'){const base=join(process.env.DSH_ATLAS_HOME,'backups');const name=fs.readdirSync(base).find(n=>n.startsWith('update-'));fs.writeFileSync(join(base,name,'files','pnpm-lock.yaml'),'corrupt');}
if(mode==='wait')await new Promise(r=>setTimeout(r,100));
process.exit(['fail','remove','corrupt-backup'].includes(mode)?9:0);
`)
  const options = (mode = 'success') => ({ dryRun: false, cli: launcher, timeoutMs: 10000,
    env: { ATLAS_FAKE_MODE: mode, ATLAS_FAKE_ROOT: root } })
  const state = () => captureProfile(dir, linkPolicy(dir, loadDependencies().dependencies))
  return { root, home, data, dir, nm, launcher, options, state }
}
function ioFault(t, method, replacement) {
  const original = fs[method]
  t.mock.method(fs, method, (...args) => replacement(original, ...args))
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
}

test('会话backup/list/restore：恢复前副本保护新内容，新增会话不删除', () => {
  const f = fixture(), b = backup()
  assert.equal(b.ok, true)
  assert.equal(listBackups().length, 1)
  put(join(f.home, 'sessions', 'a'), 'synthetic CURRENT A')
  put(join(f.home, 'sessions', 'new'), 'synthetic new session')
  const r = restore(basename(b.dir))
  assert.equal(r.ok, true)
  assert.equal(read(join(f.home, 'sessions', 'a')), 'synthetic old A')
  assert.equal(read(join(r.safetyBackup, 'data', 'a')), 'synthetic CURRENT A')
  assert.equal(read(join(f.home, 'sessions', 'new')), 'synthetic new session')
})
test('复制中断的会话半成品不会成为legacy，也不会轮转有效备份', (t) => {
  const f = fixture(), good = backup()
  ioFault(t, 'copyFileSync', (original, src, dst, ...rest) => {
    if (String(dst).includes('sessions-v1-') && basename(src) === 'b') throw new Error('synthetic copy failure')
    return original(src, dst, ...rest)
  })
  const bad = backup({ keep: 1 })
  assert.equal(bad.ok, false)
  assert.equal(listBackups().length, 1)
  assert.equal(listBackups()[0].name, basename(good.dir))
  assert.equal(restore(basename(bad.dir)).ok, false)
  assert.equal(read(join(f.home, 'sessions', 'b')), 'synthetic old B')
})
test('目录读取错误不报会话备份成功', (t) => {
  const f = fixture()
  ioFault(t, 'readdirSync', (original, dir, ...rest) => {
    if (resolve(dir) === resolve(join(f.home, 'sessions'))) throw new Error('synthetic read failure')
    return original(dir, ...rest)
  })
  assert.equal(backup().ok, false)
})
test('会话恢复部分复制失败：返回false/部分数量/保护副本', (t) => {
  const f = fixture(), b = backup()
  put(join(f.home, 'sessions', 'a'), 'CURRENT')
  ioFault(t, 'copyFileSync', (original, src, dst, ...rest) => {
    if (String(dst).includes('.atlas-restore-') && basename(src) === 'b') throw new Error('synthetic restore failure')
    return original(src, dst, ...rest)
  })
  const r = restore(basename(b.dir))
  assert.equal(r.ok, false); assert.equal(r.partial, true); assert.equal(r.files, 1)
  assert.equal(read(join(r.safetyBackup, 'data', 'a')), 'CURRENT')
})
test('会话来源名字/链接与目标Junction拒绝，不触碰外部目录', () => {
  const f = fixture(), b = backup(), external = join(f.root, 'external')
  fs.mkdirSync(external); put(join(external, 'sentinel'), 'untouched')
  for (const name of ['../outside', '..', '/absolute', basename(b.dir) + '/data']) assert.equal(restore(name).ok, false)
  fs.symlinkSync(external, join(f.data, 'sessions-backup', 'sessions-evil'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(restore('sessions-evil').ok, false)
  fs.symlinkSync(external, join(f.home, 'sessions', 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(restore(basename(b.dir)).ok, false)
  assert.equal(read(join(external, 'sentinel')), 'untouched')
})
test('真实rescue CLI的会话三个子命令均连通', () => {
  const f = fixture(), rescue = join(sourceRoot, 'rescue.mjs')
  const run = (args) => spawnSync(process.execPath, [rescue, ...args], { encoding: 'utf8', env: process.env, windowsHide: true })
  assert.equal(run(['sessions-backup']).status, 0)
  const name = listBackups()[0].name
  assert.equal(run(['sessions-list']).status, 0)
  put(join(f.home, 'sessions', 'a'), 'CURRENT CLI')
  assert.equal(run(['sessions-restore', name]).status, 0)
  assert.equal(read(join(f.home, 'sessions', 'a')), 'synthetic old A')
  assert.equal(run(['sessions-restore', '../../bad']).status, 1)
})
test('巡检实际入口用空插件集合离线执行会话保险', async () => {
  const f = fixture(), oldFetch = globalThis.fetch
  globalThis.fetch = () => { throw new Error('test forbids network') }
  try {
    const { runPatrol } = await import('../lib/upstream/patrol.js')
    const r = await runPatrol({ root: f.data, plugins: [], patches: [], maxNetwork: 0 })
    assert.equal(r.sessionBackup.created, true)
    assert.equal(listBackups().length, 1)
  } finally { globalThis.fetch = oldFetch }
})
test('更新来源仅接受registry版本/标签，拒绝Git和路径等协议', () => {
  for (const spec of ['^1.2.3', '~1.0', '*', 'latest', '1.2.3-rc.1', '>=1.0.0 <2.0.0', '1.0.0 - 2.0.0']) assert.equal(isUpdatableSpec(spec), true, spec)
  for (const spec of ['git+https://example.invalid/x', 'git+ssh://example.invalid/x', 'github:owner/repo', 'owner/repo', 'link:../x', 'file:../x', 'workspace:*', 'https://example.invalid/a.tgz', '../local', 'npm:alias@1', 'git@example.invalid:a']) assert.equal(isUpdatableSpec(spec), false, spec)
})
test('非法/重复/未知集合整体验证后才备份，dryRun零写入', async () => {
  const f = fixture(), before = tree(f.root)
  for (const names of [['dsh-a', '../x'], ['dsh-a', 'dsh-a'], ['dsh-a', 'unknown'], ['--flag'], ['dsh-a', '']]) {
    const r = await updatePlugins(names, f.options())
    assert.equal(r.ok, false); assert.equal(r.phase, 'validate')
  }
  const dry = await updatePlugins(['dsh-a'], { cli: f.launcher })
  assert.equal(dry.dryRun, true)
  verifyTree(f.root, before)
})
test('profile名不接受shell注入；包安装目录Junction拒绝', async () => {
  const f = fixture(), external = join(f.root, 'external')
  assert.equal((await updatePlugins(['dsh-a'], { ...f.options(), profile: 'test&echo-bad' })).phase, 'validate')
  fs.renameSync(join(f.nm, 'dsh-a'), external)
  fs.symlinkSync(external, join(f.nm, 'dsh-a'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await updatePlugins(['dsh-a'], f.options())).phase, 'validate')
  assert.equal(fs.existsSync(join(f.data, 'backups')), false)
})
test('执行失败完整回滚声明、锁、传递依赖和新增文件，保留失败现场', async () => {
  const f = fixture(), before = f.state()
  const r = await updatePlugins(['dsh-a'], f.options('fail'))
  assert.equal(r.ok, false); assert.equal(r.rolledBack.ok, true); assert.equal(r.rolledBack.verified, true)
  assert.equal(r.versions.afterRollback['dsh-a'], '1.0.0')
  assert.deepEqual(f.state(), before)
  assert.equal(read(join(r.rolledBack.displaced, 'node_modules', 'dsh-b', 'transitive.txt')), 'new transitive')
})
test('执行器删除整个node_modules后失败，仍能从完整备份恢复', async () => {
  const f = fixture(), before = f.state()
  const r = await updatePlugins(['dsh-a'], f.options('remove'))
  assert.equal(r.ok, false); assert.equal(r.rolledBack.ok, true)
  assert.deepEqual(f.state(), before)
})
test('执行返回0但安装校验失败也必须完整回滚', async () => {
  const f = fixture(), before = f.state()
  const r = await updatePlugins(['dsh-a'], f.options('invalid'))
  assert.equal(r.phase, 'verify'); assert.equal(r.rolledBack.ok, true)
  assert.deepEqual(f.state(), before)
})
test('备份不完整时不运行CLI、不修改profile、不把空拷贝当成功', async () => {
  const f = fixture(), before = f.state()
  const r = await updatePlugins(['dsh-a'], { ...f.options(), copyTree: (_src, dst) => fs.mkdirSync(dst) })
  assert.equal(r.phase, 'backup'); assert.equal(r.ok, false)
  assert.deepEqual(f.state(), before)
  assert.equal(fs.existsSync(join(f.dir, 'argv.json')), false)
})
test('恢复负载损坏：不能声称已回滚，也不能覆写现状', async () => {
  const f = fixture(), r = await updatePlugins(['dsh-a'], f.options('corrupt-backup'))
  assert.equal(r.ok, false); assert.equal(r.rolledBack.ok, false)
  assert.equal(r.rolledBack.verified, false)
  assert.equal(JSON.parse(read(join(f.nm, 'dsh-a', 'package.json'))).version, '2.0.0')
})
test('恢复文件操作失败准确报告，不把复制完成视为恢复成功', async (t) => {
  const f = fixture()
  ioFault(t, 'renameSync', (original, src, dst) => {
    if (String(src).includes('.atlas-restore-') && basename(src) === 'node_modules') throw new Error('synthetic rename failure')
    return original(src, dst)
  })
  const r = await updatePlugins(['dsh-a'], f.options('fail'))
  assert.equal(r.ok, false); assert.equal(r.rolledBack.ok, false)
  assert.equal(fs.existsSync(join(r.backupDir, 'node_modules', 'dsh-a', 'package.json')), true)
  assert.equal(fs.existsSync(join(r.rolledBack.displaced, 'node_modules', 'dsh-a', 'package.json')), true)
})
test('保留已声明link用户源码，snapshot只存链接而非源码副本', async () => {
  const f = fixture(), external = join(f.root, 'user-source')
  put(join(external, 'private-synthetic.txt'), 'source unchanged')
  const pkg = JSON.parse(read(join(f.dir, 'package.json')))
  pkg.dependencies['local-plugin'] = 'link:../../../user-source'
  json(join(f.dir, 'package.json'), pkg)
  fs.symlinkSync(external, join(f.nm, 'local-plugin'), process.platform === 'win32' ? 'junction' : 'dir')
  const before = f.state(), externalBefore = tree(external)
  assert.equal((await updatePlugins(['local-plugin'], f.options())).phase, 'validate')
  const r = await updatePlugins(['dsh-a'], f.options('fail'))
  assert.equal(r.rolledBack.ok, true)
  assert.deepEqual(f.state(), before); verifyTree(external, externalBefore)
  assert.equal(fs.lstatSync(join(r.backupDir, 'node_modules', 'local-plugin')).isSymbolicLink(), true)
})
test('未知外部链接和备份根Junction在任何写入前拒绝', () => {
  const f = fixture(), external = join(f.root, 'outside')
  fs.mkdirSync(external)
  fs.symlinkSync(external, join(f.nm, 'evil'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(backupPlugins(['dsh-a']).ok, false)
  assert.equal(fs.existsSync(join(f.data, 'backups')), false)
  fs.mkdirSync(f.data); fs.symlinkSync(external, join(f.data, 'backups'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => updateBackupRoot(), /链接|Junction/)
})
test('真实平台合成launcher通过空格/中文路径与scope参数，拒绝shell元字符', async () => {
  const f = fixture(), echo = join(f.root, 'echo payload.mjs')
  put(echo, 'console.log(JSON.stringify(process.argv.slice(2)))')
  let cli = echo
  if (process.platform === 'win32') {
    cli = join(f.root, 'echo space 中文.cmd')
    put(cli, '@echo off\r\n"' + process.execPath + '" "%~dp0echo payload.mjs" %*\r\n')
  }
  const args = ['plugin', '--profile', 'safe-profile', 'add', '@scope/plugin@latest', '--ignore-scripts']
  const r = await runDshCli(args, { cli, timeoutMs: 10000 })
  assert.equal(r.status, 0, r.stderr + (r.error?.message || ''))
  assert.deepEqual(JSON.parse(r.stdout.trim()), args)
  if (process.platform === 'win32') for (const bad of ['x&echo', '%PATH%', 'x|bad', 'x"bad', 'x^bad', '!bad!']) assert.throws(() => cliInvocation(cli, [bad]))
})
test('成功更新保留有效快照，CLI收到禁止脚本与脱离外层workspace的参数', async () => {
  const f = fixture(), r = await updatePlugins(['dsh-a'], f.options())
  assert.equal(r.ok, true)
  assert.equal(r.versions.after['dsh-a'], '2.0.0')
  const args = JSON.parse(read(join(f.dir, 'argv.json')))
  for (const flag of ['--ignore-scripts', '--ignore-pnpmfile', '--ignore-workspace']) assert.ok(args.includes(flag))
  assert.equal(fs.existsSync(join(r.backupDir, 'transaction.json')), true)
  assert.equal(restorePlugins(r.backupDir, ['unknown']).ok, false)
  assert.equal(fs.existsSync(join(f.dir, '.atlas-update.lock')), false)
})
test('并发写入口由profile事务锁拒绝，已有操作仍可成功', async () => {
  const f = fixture(), first = updatePlugins(['dsh-a'], f.options('wait'))
  const second = await updatePlugins(['dsh-a'], f.options())
  assert.equal(second.phase, 'lock')
  assert.equal((await first).ok, true)
})
test('恢复前保护副本失败则不覆盖当前会话；损坏备份同样拒绝', (t) => {
  const f = fixture(), b = backup()
  put(join(f.home, 'sessions', 'a'), 'CURRENT PROTECTED')
  ioFault(t, 'copyFileSync', (original, src, dst, ...rest) => {
    if (String(dst).includes('sessions-v1-') && !String(dst).startsWith(b.dir) && basename(src) === 'a') throw new Error('safety copy failed')
    return original(src, dst, ...rest)
  })
  assert.equal(restore(basename(b.dir)).ok, false)
  assert.equal(read(join(f.home, 'sessions', 'a')), 'CURRENT PROTECTED')
  put(join(b.dir, 'data', 'b'), 'corrupt')
  assert.equal(restore(basename(b.dir)).ok, false)
})
test('通用写前备份缺一个必需文件也不能运行action', async () => {
  const f = fixture()
  let executed = false
  assert.equal(backupBeforeWrite({ profileName: 'test' }).ok, false)
  const result = await withBackup({ profileName: 'test' }, () => { executed = true })
  assert.equal(result.ok, false); assert.equal(executed, false)
  put(join(f.dir, 'cordis.patch.yml'), 'config: {entries: []}')
  assert.equal(backupBeforeWrite({ profileName: 'test' }).ok, true)
})
test('配置rescue恢复在覆盖前保存当前内容并拒绝路径名', async () => {
  const f = fixture(), rescue = await import('../rescue.mjs')
  const old = read(join(f.dir, 'package.json'))
  put(join(f.dir, 'package.json.bak-synthetic'), old)
  put(join(f.dir, 'package.json'), '{"current":true}')
  const r = rescue.restore('package.json.bak-synthetic', 'test')
  assert.equal(r.ok, true)
  assert.equal(read(join(f.dir, r.safetyCopy)), '{"current":true}')
  assert.equal(read(join(f.dir, 'package.json')), old)
  assert.equal(rescue.restore('../../escape', 'test').ok, false)
})
test('CLI超时终止合成子进程树，不把超时当成功', async () => {
  const f = fixture(), script = join(f.root, 'hang.mjs'), sentinel = join(f.root, 'late-write')
  put(script, `import{spawn}from'node:child_process';spawn(process.execPath,['-e',${JSON.stringify("setTimeout(()=>require('fs').writeFileSync(" + JSON.stringify(sentinel) + ",'bad'),800)")}],{stdio:'ignore'});setInterval(()=>{},1000);`)
  const r = await runDshCli([], { cli: script, timeoutMs: 150 })
  assert.equal(r.error?.code, 'ETIMEDOUT')
  assert.equal(r.quiescent, true)
  await new Promise((resolve) => setTimeout(resolve, 900))
  assert.equal(fs.existsSync(sentinel), false)
})
test('atlas_update实际注册入口await事务：默认预演、非法集合拒绝、真写仍保留', async () => {
  const f = fixture(), tools = new Map()
  const cliDir = join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin')
  put(join(cliDir, 'payload.mjs'), read(f.launcher))
  if (process.platform === 'win32') put(join(cliDir, 'dsh.cmd'), '@echo off\r\n"' + process.execPath + '" "%~dp0payload.mjs" %*\r\n')
  else { put(join(cliDir, 'dsh'), '#!' + process.execPath + '\n' + read(f.launcher)); fs.chmodSync(join(cliDir, 'dsh'), 0o755) }
  Object.assign(process.env, { ATLAS_FAKE_MODE: 'success', ATLAS_FAKE_ROOT: f.root })
  const { apply } = await import('../lib/index.js')
  const ctx = { tools: { register: (definition) => tools.set(definition.name, definition) }, get: () => null,
    inject: (_names, callback) => callback({ get: () => null, webServer: { register: () => () => {} } }) }
  apply(ctx, { root: f.data, patrolTickMinutes: 0 })
  for (let i = 0; i < 100 && tools.size < 23; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  const t = tools.get('atlas_update'); assert.ok(t)
  assert.match((await t.execute({ action: 'run', packages: 'dsh-a' })).text, /预演/)
  assert.equal(fs.existsSync(join(f.dir, 'argv.json')), false)
  assert.match((await t.execute({ action: 'run', packages: 'dsh-a,,dsh-b', dryRun: false })).text, /包名不合法/)
  const result = await t.execute({ action: 'run', packages: 'dsh-a', dryRun: false })
  assert.match(result.text, /更新完成/)
})
test('JS launcher即使由Electron宿主调用也显式选择Node执行模式', async () => {
  const f = fixture(), script = join(f.root, 'node-mode.mjs')
  put(script, 'console.log(process.env.ELECTRON_RUN_AS_NODE)')
  const r = await runDshCli([], { cli: script, timeoutMs: 10000 })
  assert.equal(r.status, 0)
  assert.equal(r.stdout.trim(), '1')
})
