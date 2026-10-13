---
name: deepseek-monitor
description: 在 Codex 中打开本机 DeepSeek 辅助任务的实时回复与活动面板。用户要求查看 DeepSeek 的进度、回复或监看窗口时使用；执行委派仍由现有 deepseek-helper 负责。
---

在用户已授权的本地监看范围及宿主当前权限内，调用本插件 `monitor_open` 显示只读 MCP App。授权依据为当前用户的明确设置或后续指令；安装文件本身不代表授权。面板自动刷新本地任务列表、公开回复文本、工具活动、模型确认状态、候选文件和失败原因。它不会发起模型请求或更改 DeepSeek 权限。

下文 `<CODEX_HOME>` 指环境变量 `CODEX_HOME`；未设置时使用 `os.homedir()` 下的 `.codex`。如果当前宿主未渲染 MCP App，使用返回的 `structuredContent.browser.url` 调用 `open_in_codex`，target type browser，放到右侧面板。没有加载新工具时，通过 Node.js 运行已安装插件根目录下的 `server/launch.mjs`；优先相对于本技能目录定位 `../../server/launch.mjs`，标准安装位置为 `<CODEX_HOME>/plugins/deepseek-monitor/server/launch.mjs`。用返回的 `url` 在 `open_in_codex` 中打开。后台服务只监听 127.0.0.1；URL 中的访问令牌仅用于本机窗口，不要发送给外部服务。

任务数据来自 `deepseek-helper` 的流式观察器，位于 `<CODEX_HOME>/deepseek-monitor/runs/`。只记录公开回复和经过筛选的活动，不记录隐藏推理、工具参数、快照内容或凭据。面板只能监看升级后的 helper 调用，不是 DeepSeek 桌面端全部会话，也不是 Codex 原生子代理列表。

正在生成的文字可能在重试后丢弃，最终回复以完成事件为准。完成代表 DeepSeek 返回了结果，仍需主代理独立核验。超过 15 秒没有心跳的未结束任务显示中断提示。

当用户要执行新任务时读取并应用已安装的 deepseek-helper Skill，由它在已有授权范围内按需委派；不要由监看工具开放新的执行能力。Harness 安装目录依次取 `DEEPSEEK_HARNESS_HOME`、helper 技能根目录 `helper.config.json` 的 `installation`、默认 `D:/DeepSeek Harness`；固定 **DeepSeek-V41-Flash / Max** 设置由 helper 核验。用户只问状态时使用 monitor_list/monitor_get，不发起额外 DeepSeek 请求。
