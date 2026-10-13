# DeepSeek Codex Companion

**让 Codex 按需通过本机 DeepSeek Harness 和 OpenCode 调用 DeepSeek，支持两个独立工作包并行，并在 Codex 中实时看到公开回复与任务进度。**

这个项目把两部分放在一起：`deepseek-helper` Skill 负责受控委派，`deepseek-monitor` 插件负责展示进度。Codex 决定任务和范围，DeepSeek 提供分析或候选稿，Codex 复核后再执行和采纳。

适合代码审查、局部故障分析、方案比较、测试设计、资料整理，以及候选补丁和文档的起草。DeepSeek 可以深入参与一个明确的子任务，但始终由主代理调度。

当前插件版本：**1.1.0**；Skill 修订：**`2026-10-14-dual-backend`**。默认使用 Harness，有两个独立工作包时可由 Harness 与 OpenCode 各承担一路，两路都可以根据主代理反馈继续迭代。权限和验收标准相同，中型任务默认总预算二十分钟，大型四十五分钟，分别限制无进展时间。监看列表与详情标明来源，保留保存失败重试和恢复机制。[阅读 DeepSeek 受控辅助能力评估](docs/deepseek-capability-evaluation-2026-10-13.md)，了解已评估的 Harness／模型组合及其适用边界。

![DeepSeek 实时监看面板](docs/monitor-preview.jpg)

图中为开发联调示例，展示公开回复过滤与重试规则的审查任务。

> 非官方的 Windows 本地集成。通过外部 Harness 或 OpenCode 进程协作，未将 DeepSeek 注册为 Codex 原生子代理。监看面板提供类似的可见性，原生子代理列表及其生命周期机制仍由 Codex 自己管理。

## 包含什么

| 组件 | 用途 |
| --- | --- |
| `skills/deepseek-helper` | 发起调用，固定模型设置，提供文件快照与受限工具，收集候选结果，并指导分项核验 |
| `skills/deepseek-helper/scripts/verify-result.mjs` | 对保存的调用记录及可选 JSON 输出契约做机械检查，不执行候选或自动接受结果 |
| `plugins/deepseek-monitor` | MCP 工具、只读 MCP App 和本机浏览器面板，展示任务、流式公开回复、活动及状态 |
| `scripts/install.mjs` | 安装 Skill 与插件文件，定位 Node.js，生成独立的本地插件市场 |
| `examples` | 最小调用请求，以及可选的跨会话自动委派偏好示例 |
| `test` 与各组件的 `test` | 无需账号、不会调用模型的本地测试 |
| `docs/deepseek-capability-evaluation-2026-10-13.md` | 能力评估的方法、分项结果、实际反例、限制与 Skill 改进对应关系 |

本项目的配套运行器使用 Node.js 内置模块，无需在仓库执行 `npm install`，不包含 Codex、DeepSeek Harness、OpenCode、模型文件或第三方 SDK。

## 协作方式

```text
用户任务 → Codex 选择工作包、材料、权限与预算
                       ↓
       Harness 工作包 A     OpenCode 工作包 B
       独立受控会话          独立受控会话
       （无依赖时可并行，每个工作包只选一路）
                       ↓
              公开回复、分析、候选文件
                       ↓
            Codex 分别复核、测试、集成

          监看面板按来源展示回复与活动
```

权限由每次请求的 `mode` 决定：

| 模式 | DeepSeek 可以做什么 | 典型用途 |
| --- | --- | --- |
| `text` | 处理输入文本，无工具 | 有来源的摘要、局部分析、比较、草稿；机械提取优先用脚本 |
| `inspect` | 列出、按行读取、搜索主代理选定的不可变文件快照 | 审查代码、寻找故障证据 |
| `propose` | 在快照工具基础上，写入本次独立目录中的候选文件 | 起草修复、测试或补丁 |

候选文件不会自动覆盖项目或执行。主代理可以带着验证结果发起反馈续作；对同一交付物的同一纠错目标，默认最多追加两轮。这不是整个任务或对话的调用上限，后续真正的新工作包仍可派发，也不能通过改名绕过纠错停止条件。它不向 DeepSeek 开放任意终端、任意文件读写、联网工具、凭据操作或再委派。限制由应用层实现，不能视为操作系统沙箱。

### 中等任务中的持续协作

新版 Skill 要求主代理在任务拆分、进入实现/测试阶段，以及获得新需求或失败证据时重新判断分工。已有一次调用不会阻止下一次协作；有清楚契约和独立验收办法的模块实现、测试文件、局部重构和修复，优先考虑让 DeepSeek 产出候选文件，主代理同时推进集成或独立测试。

例如：由 DeepSeek 起草解析模块，主代理准备调用方集成和边界测试；出现具体失败时将反例与最新快照交回修订；模块通过后，另一个独立的校验规则工作包仍可继续委派。已有明确契约时可直接使用 `propose`，无需先多调用一轮计划或审查；若工作已完成，也不为体现“多次调用”追加请求。

目标是减少主代理重复起草与总返工。主代理仍审阅、测试和决定采用，但不同时从零重写同一候选，也不默认将同一实现发给多个代理。实际节省取决于委派成本、采纳结果和返工，当前没有可比额度数据，不能承诺节省比例。具体拆分与反馈写法见[任务契约与反馈](skills/deepseek-helper/references/task-contracts.md)。

### Harness 与 OpenCode 的双路分工

请求用 `backend` 选择一路：`harness` 是默认值，`opencode` 需要显式指定。两个没有未满足依赖的工作包可以同时发起，通常每个后端各一路。例如 Harness 起草已定义接口的解析模块，OpenCode 起草独立的格式校验模块，Codex 同时处理调用方集成和独立测试。请求、会话、预算、结果和候选目录分别管理，模型不会自主交换材料。

同一实现不重复派发给两路；后续依赖前一包结果时，先核验再派发。两路都可以按验证反馈继续协作，同一交付物的纠错次数不会因切换后端而重置。认证、模型或工具校验失败时先诊断，不静默换后端或降级模型。并行可能减少等待，但服务并发、限流、验收和返工都会影响收益；目前没有性能或额度对照证据，不能承诺提速或节省比例。

模型固定为 **DeepSeek-V41-Flash / Max**：Harness 检查 `deepseek-official / deepseek-flash / max`；OpenCode 检查 `deepseek / deepseek-flash / max`（模型选择 `deepseek/deepseek-flash#max`），并核对实际运行证据。设置不匹配会失败。结果即使通过协议与完成状态检查，也只是需要独立复核的候选稿。

## 环境要求

- Windows；Harness 适配器使用 `DeepSeek Harness.exe` 和其内部 CLI，OpenCode 适配器使用本机 `opencode-cli.exe`。
- Node.js 20 或更高版本，`node` 可用。已验证环境使用 Node.js 24。
- 按使用的后端安装并完成 DeepSeek Harness／OpenCode 账号配置，能够使用上述 Flash / Max 设置。双路协作需要两条后端均可调用。
- 支持本地插件和 Skill 的 Codex 桌面环境。插件安装命令在 Codex CLI `0.162.0-alpha.17.2` 验证。

Harness 适配基于 **0.2.0-rc.2**，OpenCode 适配基于 CLI **2.0.28**。它们依赖相应事件和 CLI 接口，升级后可能需要适配。这里不承诺其他版本或其他操作系统兼容。调用使用后台进程，不要求把桌面窗口打开到前台，也不会让普通桌面会话继承辅助代理权限。

OpenCode 运行器严格检查 CLI 版本，使用私有配置目录和 `--standalone` 进程，关闭项目指令、兼容配置及外部技能发现，复用 OpenCode 自己保存的认证，不导出或复制密钥。系统级自定义 OpenCode 配置需先审查；运行器不会自动合并它。MCP 显式关闭 Code Mode，仅暴露本次允许的快照与候选工具；每次真实 HTTP 请求都核验模型、Max 设置、官方端点及完整工具清单，结束后再核验会话和每条 assistant 记录。后端升级或协议变化会明确失败，不静默放宽控制。

## 安装

下载本仓库 ZIP 并解压，或用 Git 克隆：

```powershell
git clone https://github.com/swat22544/deepseek-codex-companion.git
cd deepseek-codex-companion
```

在仓库根目录打开 PowerShell，执行：

```powershell
node scripts/install.mjs --dsh-home "D:\DeepSeek Harness" --opencode-cli "D:\OpenCode\@opencodedesktop\resources\opencode-cli.exe"
```

将 `--dsh-home` 改成实际包含 `DeepSeek Harness.exe` 的目录，将 `--opencode-cli` 改成 OpenCode CLI 可执行文件路径；只使用 Harness 时可省略后者。安装器默认使用 `$env:CODEX_HOME`；未设置时使用当前用户主目录下的 `.codex`。下文 `<CODEX_HOME>` 是这个实际目录的占位符，运行命令前应替换为自己的绝对路径。安装器会：

1. 复制 Skill 到 `<CODEX_HOME>/skills/deepseek-helper`。
2. 复制插件到 `<CODEX_HOME>/plugins/deepseek-monitor`，在 MCP 配置中写入本次运行的 Node.js 路径。
3. 将后端程序路径保存到已安装 Skill 的 `helper.config.json`，不把账号密钥复制到 Skill。
4. 在 `<CODEX_HOME>/deepseek-companion-marketplace` 创建独立本地插件市场，不改写现有个人市场。
5. 输出后续的两条 Codex 命令。

**继续执行安装器输出的 `nextCommands`，插件才会注册到 Codex：**

```powershell
codex plugin marketplace add "<安装器输出的 marketplaceRoot>" --json
codex plugin add deepseek-monitor@deepseek-codex-companion --json
```

如果终端找不到 `codex`，使用本机 Codex CLI 的完整路径执行相同参数。插件/Skill 可能需要在新对话或重启 Codex 后加载。安装器仅复制文件，不登录账号、不调用模型，也不自动修改全局 `AGENTS.md`。

已有同名组件时，安装器默认停止。更新时可加 `--overwrite`，它先备份原组件到 `<CODEX_HOME>/backups/deepseek-companion-时间戳/`，然后更新同名文件；额外的本地文件保留。若 Node.js 移动了位置，重新运行安装器并重新注册插件。

更新已有安装时，在本仓库目录运行以下命令，并将后端路径替换为实际路径：

```powershell
git pull --ff-only
node scripts/install.mjs --dsh-home "D:\DeepSeek Harness" --opencode-cli "D:\OpenCode\@opencodedesktop\resources\opencode-cli.exe" --overwrite
```

继续按安装器输出的 `nextCommands` 完成插件注册。如果早期安装已注册为 `deepseek-monitor@local-personal`，可先用 `codex plugin list --json` 确认来源，再运行 `codex plugin add deepseek-monitor@local-personal --json` 更新原有条目，避免重复注册。新版 Skill 在被下一次读取后生效；已加载旧技能的对话可新建对话使用更新后的规则。已经运行的监看 HTTP 服务需重新加载新版文件；固定地址配置及运行记录位于组件目录之外，应予保留。

高级路径设置：

| 设置 | 作用 |
| --- | --- |
| `DEEPSEEK_HARNESS_HOME` | Harness 程序目录，优先于 `helper.config.json`；两者都没有时默认 `D:/DeepSeek Harness` |
| `DEEPSEEK_OPENCODE_CLI` | OpenCode CLI 路径，优先于 `helper.config.json` 的 `opencodeExecutable`；两者都没有时默认 `D:/OpenCode/@opencodedesktop/resources/opencode-cli.exe` |
| `--opencode-cli PATH` | 安装时将 OpenCode CLI 位置保存到本地 `helper.config.json` |
| `DSH_HOME` | Harness 的数据与配置目录，默认用户主目录下的 `.dsh`，与程序目录不同 |
| `CODEX_HOME` | Codex 数据根目录，决定 Skill、插件及监看数据位置 |
| `--codex-home PATH` | 安装到指定 Codex 数据根；相应 Codex 与委派进程也应使用同一 `CODEX_HOME` |

不要向 Harness 的 `codex-helper` 专用 profile 安装桌面插件。运行器只接受已知的 base/headless 组合与空用户补丁；意外 profile 依赖或非空全局 `cordis.patch.yml` 会使调用停止。OpenCode 复用本机已配置的认证并建立独立受控会话；主代理不读取或复制认证内容，不直接使用普通桌面会话绕开模型与工具限制。

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

从 1.0.2 起，可选的 `service-config.json` 支持固定本机端口及持久访问令牌，`server/watchdog.mjs` 可在服务中断后尝试恢复。它们只维护监看服务，不启动或恢复模型任务。普通安装不会自动为每位用户创建 Windows 启动/登录计划任务；需要常驻时单独配置运行方式。未配置固定地址时仍使用随机端口与令牌。已有本机服务配置在更新时保留，配置与令牌不要上传。

### 最小调用示例

在一个工作目录中，把 [examples/text-request.json](examples/text-request.json) 复制到 `work/request.json`，然后运行：

```powershell
node "<CODEX_HOME>/skills/deepseek-helper/scripts/delegate.mjs" "绝对路径/work/request.json" "绝对路径/work/result.json"
```

这是一次真实的 DeepSeek 模型调用，需要可用账号。每次使用新文件名；请求协议、文件范围、预算、反馈续作和结果检查见 [请求与输出说明](skills/deepseek-helper/references/request.md)。不要仅根据面板显示“完成”就接受结果。

请求中省略 `backend` 使用 Harness；添加 `"backend": "opencode"` 使用 OpenCode。准备两个不同工作包的请求文件后，可通过同一 `delegate.mjs` 入口并行启动两次进程，各写一份结果。监看列表、详情与模型确认活动分别显示 Harness／OpenCode，搜索框也可按来源筛选；历史记录没有来源字段时显示 Harness。两个进程结束后分别核对结果，不能只等其中一个完成。

### 自动时间预算

新请求省略时间字段即可自动分配，也可写 `"taskSize": "auto"`：

| 自动任务规模 | 判定条件（从大到小） | 总任务时限 | 无进展时限 |
| --- | --- | --- | --- |
| 大 | 至少 8 个实际文件快照，或输入与快照合计至少 128 KiB | 45 分钟 | 10 分钟 |
| 中 | 未达大任务条件，且为 `inspect/propose` 模式，或合计至少 16 KiB | 20 分钟 | 7 分钟 |
| 小 | 其他情况 | 5 分钟 | 3 分钟 |

输入按指令、输入正文及反馈的 UTF-8 字节计算；快照使用实际去重后的文件数量和字节数。主代理可显式选择 `taskSize: "small" | "medium" | "large"`，或用 `totalTimeoutMs/idleTimeoutMs` 指定毫秒预算，最长 60 分钟。显式时间优先于档位默认值。自动无进展预算不会超过总预算；显式无进展预算大于总预算会报错。

自动分类无法仅靠材料长度判断算法或状态逻辑的难度。材料较短，但涉及复杂状态、几何算法或多项兼容约束的候选实现，主代理可以明确选 `large`。1.0.4 的默认总预算从 5/15/30 分钟提高到 5/20/45 分钟；无进展预算仍是 3/7/10 分钟。新默认只作用于新调用，既有显式时间和历史记录保持原值。

两路使用相同的预算规则并各自计时，一路的进展不能为另一路续期。总计时从本次快照准备完成、进入后端启动阶段时开始，包含模型等待和工具处理，不包含安装及前置文件准备。有效模型开始/输出活动（包括不保存私有文字的推理活动元数据）、工具开始/完成和最终回复会重置无进展计时，总时限始终不延长。监看心跳与界面刷新不续期；无进展超时也不能证明网络失败或模型卡死。

**旧请求中的 `timeoutMs: 180000` 仍然表示三分钟总预算。** 要启用自动分配，请在新请求中去掉它，或调整显式值；它与新 `totalTimeoutMs` 同时出现时必须相等。不要修改已归档请求。面板与结果文件会分别标明总时限到期或无进展超时；具体字段、45 分钟示例和失败后的处理见 [时间预算说明](skills/deepseek-helper/references/timeouts.md)。

### 监看记录中断的处理

“监看记录中断”表示记录没有及时更新，不能据此判定模型退出或网络断开。1.0.4 修复了一次文件错误就永久停止保存的问题：可恢复错误最多追加三次短重试；仍失败则保留上一份合法记录，在后续心跳继续尝试。慢写入时仅保留一个写入者和一份待写的最新快照，最终状态成功保存后才返回监看可用。

记录中的 `monitorWrite` 和结果中的 `monitor.writeDiagnostics` 仅保留计数、白名单错误码和写入阶段，不保存原始异常文字或路径。若旧版记录已中断，主代理需要核对对应结果文件和进程状态，先备份再恢复终态，并明确注明恢复来源；不能仅把残留的 `.tmp` 文件当作最终结果。真实案例、修复范围与验证见[监看恢复与预算调整记录](docs/monitor-recovery-validation-2026-10-13.md)。

### 分项核验结果

新版明确区分三个层次：

1. **调用完成**：本次进程退出、请求与结果后端一致、固定模型校验、完成原因、工具记录和清理状态符合要求；OpenCode 还需 `runtimeEvidenceVerified: true`。两路分别检查。
2. **交付符合约定**：回复格式、必需字段、文件、范围与完整性符合委派前的契约。
3. **内容可以采用**：主代理独立核对事实、源码、边界示例与测试预期，并执行有意义的代码测试。

**候选代码、解释文字、源码引用、边界示例和测试预期分别核验。** 主要结论正确不能证明所有附加说明正确；可以保留已核验部分，单独纠正或舍弃错误部分。测试预期应来自独立契约或推导，不能把候选实现的输出直接当作答案。

在主代理已完成调用后，可对保存的结果做机械检查：

```powershell
node "<CODEX_HOME>/skills/deepseek-helper/scripts/verify-result.mjs" "绝对路径/work/result.json"
node "<CODEX_HOME>/skills/deepseek-helper/scripts/verify-result.mjs" "绝对路径/work/result.json" --contract "绝对路径/work/contract.json"
```

检查器支持严格解析完整 JSON 回复、显式顶层类型、顶层键约束、数组去重和独立预期值。它不是完整 JSON Schema，也不验证事实、引用或代码行为。退出码 `0` 表示机械通过，`1` 表示检查失败，`2` 表示参数、文件或契约无效；即使通过，仍返回 `independentReviewRequired: true` 与 `semanticAcceptance: false`。记录中的退出码也不能替代主代理对本次命令退出状态的实际观察。

- [任务契约与反馈指南](skills/deepseek-helper/references/task-contracts.md)：如何明确任务、提供反例、保留正确行为和组织续作。
- [分类验收规则](skills/deepseek-helper/references/verification.md)：如何核对集合、说明、引用、示例、候选代码与测试。
- [机械检查器与契约格式](skills/deepseek-helper/references/verification-contract.md)：支持范围、完整示例和 CLI/API 用法。

## DeepSeek 受控辅助能力评估

2026-10-13 在 **DeepSeek-V41-Flash / Max、Harness 0.2.0-rc.2** 下完成分项评估：**12 个初测任务、2 次同题复测、1 次需求变更续作，共 15 次委派**。初测题目和判定依据在调用前固定，答案键和隐藏测试未提供给模型；主代理与独立审查代理交叉核验结果。

初测中 **10 项核心交付通过、2 项部分通过**。这是一组自建任务的观测分布，不是一般工作正确率；“核心交付通过”也不表示解释中的每句话都正确。

| 任务类型 | 实测结果 | 对协作方式的含义 |
| --- | --- | --- |
| 跨文件代码审查 | 初测与复测各找到 3/3 预埋缺陷，无新增缺陷误报；首轮附加文字仍有错误 | 适合作为第二遍审查，逐条核验发现及建议 |
| 局部候选实现 | 两个初始模块分别通过 12/12、13/13 组隐藏测试 | 支持有明确契约的候选实现；代码与说明分开验收 |
| 主代理反馈续作 | 通过 20/20 组测试，其中 13 组旧行为、7 组新增要求 | 支持由主代理发起的需求变更迭代，保留回归检查 |
| 测试设计 | 8/8 组测试预期正确，检出 6/6 预设错误变体 | 可起草测试，预期仍需独立推导并执行 |
| 结构化提取 | 首轮漏掉 1/9 合法编号；复测内容正确却违反“仅 JSON”要求 | 机械处理优先使用脚本；格式与集合完整性分别检查 |
| 无缺陷负对照 | 正确返回空缺陷列表，但默认参数的附加示例错误 | 正确主结论不能替边界示例背书 |

15 次调用均完成且固定模型校验通过，共 **27 次底层模型请求、24 次受限工具调用**；本机端到端委派用时中位数 **23.6 秒**，范围 **6.7–72.9 秒**。不包含题目设计和人工核验时间，未据此推算费用或效率提升比例。

结论支持当前分工：DeepSeek 可以深入参与边界清楚的局部工作，主代理继续掌握执行、项目修改和最终验收。开放式研究、视觉/语音、长上下文、大型工程集成、自主执行，以及与 Codex 的同题性能对照均未评测。

完整方法、全部任务结果、反例与改进对应关系见 **[DeepSeek 受控辅助能力评估](docs/deepseek-capability-evaluation-2026-10-13.md)**；用于复算上述汇总指标的公开数据见 [评估统计摘要](docs/deepseek-capability-evaluation-2026-10-13.metrics.json)。公开材料是整理后的报告与统计，未包含本机原始会话、完整请求、候选文件或隐藏测试全集。后续时间预算与监看恢复改进单独验证，未重做或重算这组能力评估。

上述评估只覆盖当时的 Harness／模型组合。相同模型接入 OpenCode 后，工具适配、运行证据与候选交付必须独立验收，不能直接继承 Harness 工具链的验证结论。2026-10-14 的双后端安装、并行调用、候选核验与实际失败单独记录在[双后端接入验证](docs/dual-backend-validation-2026-10-14.md)，未合并进旧评估分数。

## 数据与监看范围

监看服务监听 `127.0.0.1`，默认使用随机端口与访问令牌；存在有效的本机 `service-config.json` 时使用配置的固定端口与令牌。界面没有外部脚本、字体或 CDN，服务提供只读接口。它展示经本 helper 发起的调用，不会导入 Harness 或 OpenCode 桌面端的全部聊天记录。

任务摘要、公开回复和经过筛选的活动保存在 `<CODEX_HOME>/deepseek-monitor/runs/`。观察器不直接记录隐藏推理、工具参数或快照内容，但公开回复可能复述输入材料。正在生成的草稿可能在重试后丢弃，最终回复以完成事件为准。

主代理选定的任务输入、反馈和被模型读取的文件内容会发送到 DeepSeek 服务。请按自己的项目规则选择材料；文件名过滤无法发现内容中的全部秘密。

本地请求、结果、快照和候选文件位于工作目录的 `work/`，其中 Harness 使用 `work/deepseek-runs/task-*/`，OpenCode 使用 `work/deepseek-runs/opencode-*/`。这些目录和监看记录目前没有自动保留期限；在相关调用结束后可按需手动清理。`<CODEX_HOME>/deepseek-monitor/server.json` 及可选的 `service-config.json` 含本机服务访问令牌，应留在本机。

## 验证与已知限制

在仓库根目录执行：

```powershell
node --test
```

装有 npm 时也可执行 `npm test`。测试覆盖权限限制、快照与候选文件、路径解析、安装保护与备份、监看过滤和协议、MCP 工具发现与读取，以及结果机械检查器的异常记录、严格 JSON 和本地契约。预算与进展测试使用虚拟时钟验证四十五分钟及显式六十分钟的时限、有效进展、无进展到期、总预算不可延长和字段边界，不宣称真的运行了四十五分钟模型任务。自动化测试不需要后端账号，不发起模型请求；需要文件的用例使用临时目录。真实连通性和工具联调应另行区分。

**1.1.0 的 122 项自动化测试全部通过，并已完成本地安装联调。** 修复 OpenCode 的 MCP 工具发现与首次模型请求之间的启动竞争后，真实 `inspect` 调用成功读取快照并返回可核验结果。另一个 OpenCode `propose` 模块通过 217 次独立断言；Harness 候选也通过独立边界检查与 UTF-16 单码元扫描。这些结果只证明对应接口和指定候选，不是一般能力分数。

最终安装验收同时派发 Harness 审查与 OpenCode 测试用例候选：两路调用均 `ok: true`，固定模型、清理状态与监看保存符合要求，两个委派进程存活时间重叠 **5887 毫秒**。Harness 审查交付通过；OpenCode 初版将要求的 `["", ""]` 输入写成 `[""]`，重复写入同名文件被正确拒绝，另存修正版后最终回复仍引用初版。该路因工具错误未通过机械检查，整体交付不能原样采用。主代理已单独验证修正版精确符合五组契约，但保留原始交付失败，没有为取得全绿结果反复调用。具体证据及安装文件一致性检查见[双后端接入验证](docs/dual-backend-validation-2026-10-14.md)；进程重叠证明可并行运行，不是提速或额度节省测量。

1.0.4 在开发环境中 **77 项自动化测试全部通过**。其中新增 7 项监看故障测试，覆盖瞬时与持续错误、心跳恢复、部分写入、慢写入合并、最终状态保存及异常信息过滤。详细证据与限制见[监看恢复验证记录](docs/monitor-recovery-validation-2026-10-13.md)。

1.0.3 在开发环境中 **70 项自动化测试全部通过**，安装后完成一次真实 Flash / Max 文件审查联调，确认 30/10 分钟预算和新版浏览器展示。验证范围、最终退出竞态的修复，以及调用成功但 JSON 交付格式未通过的区别，见[自适应超时验证记录](docs/adaptive-timeouts-validation-2026-10-13.md)。

另已在原始开发环境验证：真实 Flash / Max 调用、完成前持续增长的公开回复、完成事件覆盖草稿、浏览器面板的筛选/选项卡，以及窄侧栏布局。MCP 服务和 UI 资源已通过协议测试；**尚未单独确认所有目标 Codex 版本都能直接渲染原生 MCP App 卡片**，因此保留浏览器后备入口。

- 不能替代 Codex 原生子代理的线程管理、权限继承和生命周期机制。
- 不提供无条件自主执行、项目自动写入或持续常驻委派。
- 监看不等于正确性验证；模型输出可能出错。
- 原始能力评估中有 **2/15 次监看记录不可用或停留在中间状态**，对应模型调用均已完成。1.0.4 针对“一次写入错误后停止保存”的路径增加了恢复和故障测试，但历史错误的具体系统原因未被旧版记录，不能保证所有文件系统异常均已消除。有限重试与有界队列也不等于为永不返回的系统文件操作增加硬超时。面板记录中断和运行器超时是不同信号，出现时以结果文件和实际进程状态判断，不因面板滞后重复调用。
- Harness/OpenCode 接口变化、登录失效、模型不可用或受控配置被修改时，调用会报错，由主代理诊断，不静默转移到另一后端。

## 项目与外部组件

本仓库是独立的配套项目，与 OpenAI、Codex、DeepSeek、DeepSeek Harness 及 OpenCode 的官方发布无隶属关系。外部产品、名称及相关规范属于各自的维护者。本仓库未附带这些产品的程序、凭据或 SDK 源码。

当前未附加开源许可证；公开源码不等同于授予任意再分发或商用许可。如需相关授权，请先联系仓库维护者。
