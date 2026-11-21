# 预览版验收范围

2026-11-21 在 Windows、Node.js 24.22.2 和已安装的 DeepSeek Harness CLI 0.2.2-rc.1 上验证。独立 profile 使用空会话目录，关闭自动巡检，以发行候选的包入口加载。

| 检查 | 结果 |
| --- | --- |
| 宿主加载 | 真实 Cordis 服务注册了 23 个 Atlas 工具，包括 `atlas_model_check`。HTTP 路由在宿主登记，桌面 UI 的点击流程尚未验收。 |
| 模型选择 | `models` 留空。自检工具显示的 provider 和 model 与宿主 `agentDefaultModel.currentSelection()` 一致。 |
| 推理 | 已安装的 DSH LLM 服务和 pi-ai 适配器向隔离的本地 Ollama 模型发出一条合成算术问题。观测到一次流式请求、HTTP 200 和非空文本，工具耗时 1.951 秒。回复没有严格匹配预期的单个数字，验收仅覆盖调用链路。 |
| 更新与恢复 | 合成测试覆盖备份、失败回滚和恢复保护。真实桌面 profile 的插件升级与恢复仍待验收。 |
| 补丁目录 | 包内提供六项定义。未安装目标插件时，启动审计可能将 `file-missing` 也显示为补丁失效。应先核实目标是否安装。 |

隔离 profile 使用独立配置的默认模型。桌面默认模型、云账号认证、其他模型提供方和 macOS 未纳入这次真实验收。测试用本地模型、配置和请求记录均在发行包之外。

运行 `npm run verify` 可重复离线验证。真实推理还需要在自己的 DSH profile 配置可用的模型提供方，通过 `atlas_model_check` 发出一条短提示。
