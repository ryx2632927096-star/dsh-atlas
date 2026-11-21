# DSH Atlas · 插件知枢

Atlas 在 DeepSeek Harness 中建立本地工具和插件索引，查看工具使用情况、插件能力重叠、补丁状态与更新记录。需要调用模型的功能使用宿主的 LLM 服务。

## 从 npm 安装到 DSH

在终端运行下面的命令。把 `web` 换成你实际使用的 DSH profile。DSH 会安装依赖并登记插件 bundle，重新加载该 profile 后生效。

```powershell
dsh plugin --profile web add @r-xuan/dsh-atlas
```

如果这个 profile 已经链接了旧版 `dsh-atlas`，请先移除旧的 bundle 登记和依赖，再安装新包，以免重复加载。

## 安装到独立 profile

准备 Node.js 24.9 或更高版本和已安装的 DSH CLI。克隆此仓库后，先在仓库根目录执行 `npm run verify`。

在目标 profile 的 `package.json` 中，将 `dependencies["@r-xuan/dsh-atlas"]` 指向 `link:<本仓库绝对路径>`，并在 `dsh.profile.bundles` 数组中加入 `@r-xuan/dsh-atlas`。保留该 profile 的已有项。使用对应宿主的插件包管理器落实链接。确认该 profile 含 `tools` 与 `webServer` 服务后，按宿主的正常方式加载。包内的 `cordis.patch.yml` 会注册插件一次。桌面版的安装入口随发行版而异。

## 使用

| 工具 | 用途 |
| --- | --- |
| `atlas_scan`、`atlas_summary` | 扫描本地会话并查看索引统计 |
| `atlas_surface`、`atlas_pitfalls` | 查看工具使用情况和错误分类 |
| `atlas_overlap` | 查看插件能力重叠，可选择用模型复核 |
| `atlas_model_check` | 用一句自定义提示测试当前模型路由 |
| `atlas_patch`、`atlas_ledger` | 检查补丁定义和变更流水 |
| `atlas_update` | 预览可更新的插件，按需执行备份、更新和复验 |

默认数据目录为 `$DSH_HOME/dsh-atlas`。会话索引、补丁备份和恢复副本可能含使用者的私人数据，请放在本地。上游巡检会访问公开的包索引和 GitHub，`patrolTickMinutes: 0` 可关闭自动巡检。为可信本地使用环境配置宿主的网络监听与访问权限。

## 模型选择

在 `models.overlap`、`models.upstreamFix` 或 `models.delegate` 留下空对象时，Atlas 每次调用都读取宿主当前选择的 provider、model 和 reasoningEffort。只指定 model 会沿用当前 provider。完整指定 provider 和 model 会固定该槽位的路由。模型请求的目的地由所选 provider 决定。自检只发送调用者提供的提示或内置短问题。

## 验证与恢复

预览版在 Windows 的隔离 DSH profile 中验收。桌面 UI、其他操作系统和不同模型提供方的兼容性需要分别验证。[验收范围](docs/validation.md) · [更新与恢复](docs/update-recovery.md)

内置补丁目录包括六项定义。桥接授权相关条目供管理员核对，发行版不自动修改桥接的工具授权。部分第三方目标需人工复核版本适配。[第三方来源](THIRD_PARTY_NOTICES.md) · [MIT 许可证](LICENSE)
