# 更新、备份与恢复：支持范围及验证

## 支持的更新

`atlas_update`只更新当前profile的`dependencies`中已发现、名称合法、版本为registry标签或semver范围的包。
所有输入先整体验证，拒绝重复、未知、非法包名、路径穿越、Git/URL/npm alias/local来源。
当前支持DSH常见的hoisted布局：**被选中的包必须是node_modules下的普通目录**。
以`.pnpm`内部symlink/Junction暴露被选中包的布局尚不支持，会在创建备份前明确拒绝，
不会沿链接进入用户源码。profile、node_modules、scope祖先和备份根也不允许由链接替代。

保留`action=list/plan/run`；`run`也默认预演，只有显式`dryRun:false`才修改安装。
预演不创建目录、锁或备份。真实更新由DSH CLI转发pnpm，使用
`--ignore-scripts --ignore-pnpmfile --ignore-workspace`：不执行依赖生命周期/自定义pnpmfile，
不进入外层workspace。需要原生构建脚本的插件，仍需在另行审阅的构建流程中处理；
CLI退出0与本地文件校验通过不代表宿主已加载或插件行为已验收。

Windows批处理通过显式cmd参数启动，使用空格/中文路径的等价合成launcher做过验证。
参数不拼接为用户shell命令；批处理不安全的控制字符会被拒绝。
macOS/Linux寻找原生`dsh`或JS入口；本轮未在这些操作系统实际启动验证。

## 事务覆盖什么

写入前成功备份并校验：

- `package.json`、pnpm/npm/yarn/bun锁文件及其存在/不存在状态；
- `pnpm-workspace.yaml`、`cordis.patch.yml`、`cordis.yml`（原字节保留，含`config.entries`）；
- `compatibility.json`、版本豁免/兼容记录；
- **完整node_modules**，含传递依赖、`.pnpm`/`.modules.yaml`等安装状态、文件模式和SHA-256清单。

已声明的link/file/portal/workspace用户源码引用只保存链接指针，不遍历或复制源码，
更新后检查其声明和链接保持不变；未知外部链接拒绝事务。复制文件产生独立内容副本，
不延续pnpm硬链接关系。备份不完整或备份期间前态变化，均不运行CLI。

失败恢复使用已校验的完整负载。当前安装树即使已经消失也可恢复；若被换成链接则拒绝沿其写入。
恢复前准备新树，以rename保存失败现场并换入备份；声明、锁及安装树哈希和选中包版本必须与前态一致，
才报告“已还原”。损坏负载、复制/rename/复验失败均明确报告失败，并保留备份和已有现场。
现场与备份默认不自动清理。更新后只复查补丁，不声称已自动重打所有补丁。

profile下有跨进程事务锁，不要同时使用其他包管理器修改同一profile。
超时会终止本次启动的进程树；无法确认停止时保留锁和备份、不边写边回滚，需先人工核实进程。
备份及现场包含私有配置/安装状态，保留在Atlas数据目录或profile中，不应上传Git。

事务覆盖上述profile文件和安装树，**不回滚全机pnpm内容缓存、远端下载/请求、用户链接源码或其他服务状态**。
这是安装事务，不是OS沙盒；不要把它当作执行不可信任CLI或任意构建脚本的隔离机制。

## 会话保险与rescue

- `rescue.mjs sessions-backup/list/restore`和巡检使用同一实现。
- 新格式备份有完整文件清单和哈希；读取或复制任何文件失败不报告成功，不轮转有效旧备份。
  新格式半成品不能被当作legacy备份列出或恢复。历史无manifest备份可恢复其当前可验证的现存文件，
  但无法追认其过去是否完整，列表标为未验证旧格式。
- 恢复只新增/覆盖，不删除后来新增的会话。覆盖前先保存并验证当前完整内容，保护失败则不覆盖。
  部分恢复失败返回已恢复数量、失败状态和保护副本位置，不能仅凭退出到末尾报告成功。
- 备份名只能是列表中的单段名字；来源、目标和祖先拒绝符号链接/Junction或目录逃逸。
- 新备份及恢复前保护副本默认保留，不自动删除旧备份。会话仍活跃且内容变化时，完整性检查可能中止，稍后重试。

## 离线验证

```text
node scripts/verify-recovery-update.mjs
node scripts/verify-default-model.mjs
```

测试仅创建合成profile、会话、链接和launcher；不安装依赖，不请求真实模型或外部API，不启动DSH。
可通过`ATLAS_TEST_ROOT`指定测试目录。覆盖底层及实际atlas_update注册入口、rescue CLI、空插件巡检、
执行失败/成功后校验失败、安装树删除、备份不完整、恢复失败、源码链接保护与恢复前副本。
本轮真实桌面宿主升级/恢复未验证，由后续集成验收统一安排。
