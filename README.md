# DeepSeek Codex Companion

**让 Codex 按需调用本机 DeepSeek Harness，并在 Codex 中实时看到 DeepSeek 的公开回复与任务进度。**

这个项目把两部分放在一起：`deepseek-helper` Skill 负责受控委派，`deepseek-monitor` 插件负责展示进度。Codex 决定任务和范围，DeepSeek 提供分析或候选稿，Codex 复核后再执行和采纳。

适合代码审查、局部故障分析、方案比较、测试设计、资料整理，以及候选补丁和文档的起草。DeepSeek 可以深入参与一个明确的子任务，但始终由主代理调度。

![DeepSeek 实时监看面板](docs/monitor-preview.jpg)

图中为开发联调示例，展示公开回复过滤与重试规则的审查任务。

> 非官方的 Windows 本地集成。目前通过外部 Harness 进程协作，未将 DeepSeek 注册为 Codex 原生子代理。监看面板提供类似的可见性，原生子代理列表及其生命周期机制仍由 Codex 自己管理。

## 包含什么

| 组件 | 用途 |
| --- | --- |
| `skills/deepseek-helper` | 发起调用，固定模型设置，提供文件快照与受限工具，收集候选结果 |
| `plugins/deepseek-monitor` | MCP 工具、只读 MCP App 和本机浏览器面板，展示任务、流式公开回复、活动及状态 |
| `scripts/install.mjs` | 安装 Skill 与插件文件，定位 Node.js，生成独立的本地插件市场 |
| `examples` | 最小调用请求，以及可选的跨会话自动委派偏好示例 |
| `test` 与各组件的 `test` | 无需账号、不会调用模型的本地测试 |

运行时代码使用 Node.js 内置模块，无需 `npm install`，不包含 Codex、DeepSeek Harness、模型文件或第三方 SDK。

## 协作方式

```text
用户任务 → Codex 选择子任务、材料、权限与预算
                     ↓
           DeepSeek Harness / codex-helper
                     ↓
            公开回复、分析、候选文件
                     ↓
          Codex 复核、测试、决定是否采纳

          监看面板同步展示回复与活动
```

权限由每次请求的 `mode` 决定：

| 模式 | DeepSeek 可以做什么 | 典型用途 |
| --- | --- | --- |
| `text` | 处理输入文本，无工具 | 摘要、提取、比较、草稿 |
| `inspect` | 列出、按行读取、搜索主代理选定的不可变文件快照 | 审查代码、寻找故障证据 |
| `propose` | 在快照工具基础上，写入本次独立目录中的候选文件 | 起草修复、测试或补丁 |

候选文件不会自动覆盖项目或执行。主代理可以带着验证结果发起反馈续作；默认最多追加两轮。它不向 DeepSeek 开放任意终端、任意文件读写、联网工具、凭据操作或再委派。限制由应用层实现，不能视为操作系统沙箱。

模型固定为 **DeepSeek-V41-Flash / Max**。每个实际模型请求都检查内部选择 `deepseek-official / deepseek-flash / max`；不匹配会失败，不会静默降级。结果即使通过协议与完成状态检查，也只是需要独立复核的候选稿。

## 环境要求

- Windows；当前 Harness 适配器使用 `DeepSeek Harness.exe` 和其内部 CLI。
- Node.js 20 或更高版本，`node` 可用。已验证环境使用 Node.js 24。
- 已安装并完成账号配置的 DeepSeek Harness，能够使用上述 Flash / Max 设置。
- 支持本地插件和 Skill 的 Codex 桌面环境。插件安装命令在 Codex CLI `0.162.0-alpha.17.2` 验证。

Harness 适配基于 `0.2.0-rc.2` 验证，依赖其内部事件和 CLI 接口，升级后可能需要适配。这里不承诺其他版本或其他操作系统兼容。

## 安装

下载本仓库 ZIP 并解压，或用 Git 克隆：

```powershell
git clone https://github.com/swat22544/deepseek-codex-companion.git
cd deepseek-codex-companion
```

在仓库根目录打开 PowerShell，执行：

```powershell
node scripts/install.mjs --dsh-home "D:\DeepSeek Harness"
```

将路径改成实际包含 `DeepSeek Harness.exe` 的目录。安装器默认使用 `$env:CODEX_HOME`；未设置时使用当前用户主目录下的 `.codex`。下文 `<CODEX_HOME>` 是这个实际目录的占位符，运行命令前应替换为自己的绝对路径。安装器会：

1. 复制 Skill 到 `<CODEX_HOME>/skills/deepseek-helper`。
2. 复制插件到 `<CODEX_HOME>/plugins/deepseek-monitor`，在 MCP 配置中写入本次运行的 Node.js 路径。
3. 将 Harness 安装目录保存到已安装 Skill 的 `helper.config.json`。
4. 在 `<CODEX_HOME>/deepseek-companion-marketplace` 创建独立本地插件市场，不改写现有个人市场。
5. 输出后续的两条 Codex 命令。

**继续执行安装器输出的 `nextCommands`，插件才会注册到 Codex：**

```powershell
codex plugin marketplace add "<安装器输出的 marketplaceRoot>" --json
codex plugin add deepseek-monitor@deepseek-codex-companion --json
```

如果终端找不到 `codex`，使用本机 Codex CLI 的完整路径执行相同参数。插件/Skill 可能需要在新对话或重启 Codex 后加载。安装器仅复制文件，不登录账号、不调用模型，也不自动修改全局 `AGENTS.md`。

已有同名组件时，安装器默认停止。更新时可加 `--overwrite`，它先备份原组件到 `<CODEX_HOME>/backups/deepseek-companion-时间戳/`，然后更新同名文件；额外的本地文件保留。若 Node.js 移动了位置，重新运行安装器并重新注册插件。

高级路径设置：

| 设置 | 作用 |
| --- | --- |
| `DEEPSEEK_HARNESS_HOME` | Harness 程序目录，优先于 `helper.config.json`；两者都没有时默认 `D:/DeepSeek Harness` |
| `DSH_HOME` | Harness 的数据与配置目录，默认用户主目录下的 `.dsh`，与程序目录不同 |
| `CODEX_HOME` | Codex 数据根目录，决定 Skill、插件及监看数据位置 |
| `--codex-home PATH` | 安装到指定 Codex 数据根；相应 Codex 与委派进程也应使用同一 `CODEX_HOME` |

不要向 `codex-helper` 专用 profile 安装桌面插件。运行器只接受已知的 base/headless 组合与空用户补丁；意外 profile 依赖或非空全局 `cordis.patch.yml` 会使调用停止。

## 使用

在 Codex 中说：

> 请让 DeepSeek 审查这两个文件的重试逻辑，只读取我指定的文件，给出缺陷候选和测试思路。由你复核结果。

或者：

> 打开 DeepSeek 实时监看面板。

若希望在后续对话中按需自动调用，阅读并自行采用 [examples/AGENTS.deepseek.md](examples/AGENTS.deepseek.md) 中的偏好。技能自动发现不代表已授权发送项目材料，安装者的实际指令与宿主权限始终优先。

首次委派时 Skill 会尝试打开监看面板。MCP App 由宿主渲染；如未显示，Skill 会将本机浏览器面板打开到 Codex 右侧。也可手动启动浏览器后备入口：

```powershell
node "<CODEX_HOME>/plugins/deepseek-monitor/server/launch.mjs"
```

用输出的 `url` 打开面板。该链接带本机访问令牌，不适合分享。

### 最小调用示例

在一个工作目录中，把 [examples/text-request.json](examples/text-request.json) 复制到 `work/request.json`，然后运行：

```powershell
node "<CODEX_HOME>/skills/deepseek-helper/scripts/delegate.mjs" "绝对路径/work/request.json" "绝对路径/work/result.json"
```

这是一次真实的 DeepSeek 模型调用，需要可用账号。每次使用新文件名；请求协议、文件范围、预算、反馈续作和结果检查见 [请求与输出说明](skills/deepseek-helper/references/request.md)。不要仅根据面板显示“完成”就接受结果。

## 数据与监看范围

监看服务监听 `127.0.0.1`，使用随机端口与访问令牌。界面没有外部脚本、字体或 CDN，服务提供只读接口。它展示经本 helper 发起的调用，不会导入 DeepSeek 桌面端的全部聊天记录。

任务摘要、公开回复和经过筛选的活动保存在 `<CODEX_HOME>/deepseek-monitor/runs/`。观察器不直接记录隐藏推理、工具参数或快照内容，但公开回复可能复述输入材料。正在生成的草稿可能在重试后丢弃，最终回复以完成事件为准。

主代理选定的任务输入、反馈和被模型读取的文件内容会发送到 DeepSeek 服务。请按自己的项目规则选择材料；文件名过滤无法发现内容中的全部秘密。

本地请求、结果、快照和候选文件位于工作目录的 `work/`，其中运行目录为 `work/deepseek-runs/task-*/`。这些目录和监看记录目前没有自动保留期限；在相关调用结束后可按需手动清理。`<CODEX_HOME>/deepseek-monitor/server.json` 含本机服务访问令牌，应留在本机。

## 验证与已知限制

在仓库根目录执行：

```powershell
node --test
```

装有 npm 时也可执行 `npm test`。测试覆盖权限限制、快照与候选文件、路径解析、安装保护与备份、监看过滤和协议、MCP 工具发现与读取。测试在临时目录运行，不需要 Harness 账号，不发起模型请求。

另已在原始开发环境验证：真实 Flash / Max 调用、完成前持续增长的公开回复、完成事件覆盖草稿、浏览器面板的筛选/选项卡，以及窄侧栏布局。MCP 服务和 UI 资源已通过协议测试；**尚未单独确认所有目标 Codex 版本都能直接渲染原生 MCP App 卡片**，因此保留浏览器后备入口。

- 不能替代 Codex 原生子代理的线程管理、权限继承和生命周期机制。
- 不提供无条件自主执行、项目自动写入或持续常驻委派。
- 监看不等于正确性验证；模型输出可能出错。
- Harness 内部接口变化、登录失效、模型不可用或 profile 被修改时，调用会报错，由主代理诊断。

## 项目与外部组件

本仓库是独立的配套项目，与 OpenAI、Codex、DeepSeek 及 DeepSeek Harness 的官方发布无隶属关系。外部产品、名称及相关规范属于各自的维护者。本仓库未附带这些产品的程序、凭据或 SDK 源码。

当前未附加开源许可证；公开源码不等同于授予任意再分发或商用许可。如需相关授权，请先联系仓库维护者。
