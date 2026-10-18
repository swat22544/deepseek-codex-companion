# 请求与输出

两种后端、所有模式共用 `scripts/delegate.mjs` 入口；旧 `extract/classify/format/draft` 请求继续可用，未指定模式时为 `text`。新请求必须按技能路由规则显式选择 `backend`；旧单请求未指定时仍为 `harness`，这是兼容行为，不能作为新任务选路策略。

```json
{
  "backend": "harness",
  "taskType": "review",
  "mode": "propose",
  "instruction": "检查重试逻辑是否符合契约。给出带文件 ID、行号和原始哈希的缺陷候选；如需修复，保存候选补丁和测试。不要运行代码。",
  "input": "已知现象、预期行为和必要任务背景。",
  "feedback": "可选：主代理对上一轮候选的纠正和本轮要求。",
  "files": ["D:/project/src/retry.ts", "D:/project/test/retry.test.ts"],
  "taskSize": "auto",
  "maxToolCalls": 24
}
```

`backend` 仅支持 `harness` 或 `zcode`；它选择运行适配器，不扩大 `mode` 的权限。不把可执行文件路径、密钥或后端配置放进该字段。不支持的后端应明确拒绝，不静默路由到另一条后端。ZCode 请求显式填写 `"backend": "zcode"`，其他任务、文件与时间字段的含义相同。

| 后端 | 固定模型与推理等级 | 本机程序位置 |
| --- | --- | --- |
| `harness` | `deepseek-official / deepseek-flash / max` | `DEEPSEEK_HARNESS_HOME` 优先，其次技能目录 `helper.config.json` 的 `installation`，默认 `D:/DeepSeek Harness` |
| `zcode` | `zai-standard-api / GLM-5.3-Flash / max`，显示为 **GLM-5.3-Flash / Max** | `DEEPSEEK_ZCODE_HOME` 优先，其次 `helper.config.json` 的 `zcodeInstallation`，默认 `D:/Zcode` |

ZCode 通过本机 CLI 的后台 `app-server` 建立独立受控会话，不依赖桌面窗口保持前台；只向本次会话提供快照 MCP 工具。模型接入使用 `zai-standard-api` 的 Z.ai 标准 API `https://api.z.ai/api/paas/v4`、Chat Completions 协议，固定大小写一致的 `GLM-5.3-Flash` 与最高思考强度 `max`。适配器须核对实际提供方配置与运行证据，不能仅凭界面显示名认定匹配，也不改用 Coding Plan 接口。它复用 ZCode 已配置的认证，不复制密钥到请求、候选目录、监看或发布材料。使用安装器的 `--zcode-home PATH` 保存实际程序目录。

`taskType`：`extract`、`classify`、`format`、`draft`、`analyze`、`review`、`debug`、`plan`、`implement`、`test-design`。它描述工作类型，权限仅由 `mode` 决定。`implement` 产生候选实现，不能直接修改项目。

`instruction` 与 `input` 必填字符串；`feedback` 可选。三者合计上限 96 KB。工具调用默认 24 次，最多 80 次。预算用尽后由主代理收尾或重新拆分，不让辅助代理延长自身预算。

时间预算字段均可省略，由运行器在文件快照准备完成后计算：

| 字段 | 含义 |
| --- | --- |
| `taskSize` | 默认 `auto`；可显式选择 `small`、`medium`、`large` |
| `totalTimeoutMs` | 显式总时限，1000–3600000 毫秒的安全整数；最多 60 分钟 |
| `idleTimeoutMs` | 显式无进展时限，同范围，且不得超过最终总时限 |
| `timeoutMs` | 兼容旧请求的显式总时限，仍然有效；与 `totalTimeoutMs` 同时填写时必须相等 |

从 1.0.4 起，默认小/中/大任务的总时限分别为 5/20/45 分钟，无进展时限仍为 3/7/10 分钟。自动无进展时限取默认值与最终总时限的较小者；显式无进展时限超过总时限则拒绝请求，不静默缩短。`null`、字符串、非有限数值、非整数与相互矛盾的设置都无效。自动分档、起算点、进展认定、长任务示例和旧请求迁移见 [timeouts.md](timeouts.md)。退出清理最多额外等待约 7 秒，未确认清理会报告失败。

`files` 仅用于 `inspect/propose`，是主代理明确选择的绝对文件路径列表，最多 80 个、每个 256 KiB、合计 2 MiB。仅接收 UTF-8 文本，排除二进制、目录、文件符号链接和常见凭据文件名。并非所有允许大小的文件都适合一次提供；优先选择与问题直接相关的最少材料。

## 可用工具

- `helper_list_files`：返回本次快照 ID、文件名、大小与 SHA-256。
- `helper_read_file`：通过 ID 按行读取，每次最多 300 行、约 32 KB。超长单行会截断并列出 `truncatedLines`，不能把截断结果当成完整文件。
- `helper_search_text`：对全部或指定快照进行区分大小写的文字搜索，不执行正则，最多返回 60 条位置。
- `helper_write_artifact`：仅 `propose` 提供；在本次 `artifacts/` 内创建平铺文件名，不允许目录、设备名或替换已有文件。每个最多 256 KiB、合计 1 MiB、最多 12 个。可以提交代码、测试、diff、patch 和文档；创建不等于执行或应用。

快照与候选稿在当前任务的 `work/deepseek-runs/` 中，两路使用独立运行目录。脚本不会读取主代理未列出的项目文件；通常无需把整个工程或聊天记录交给辅助模型。

## 并行与反馈

一个请求只包含一个后端与一个工作包。两个没有未满足依赖的工作包默认使用 `delegate-batch.mjs`，一次启动 Harness 与 ZCode，各启一路。也可同时启动两次 `delegate.mjs`，但应先启动两条再等待，不要在两次启动之间等待第一条完成。分别跟踪退出、结果和候选；不要同时写同一个请求/结果文件，也不要将同一实现重复派发。模型回复不会自动流入另一条会话。

批次示例（两份契约相互独立，不是把同一题重复发两次）：

```json
{
  "version": 1,
  "independent": true,
  "tasks": [
    {"id":"retry-review","request":{"backend":"harness","taskType":"review","mode":"inspect","instruction":"审查重试模块，给出可复现的契约违反；可无发现。","input":"最多重试3次，调用方允许取消。","files":["D:/project/retry.mjs"]}},
    {"id":"format-module","request":{"backend":"zcode","taskType":"implement","mode":"propose","instruction":"实现独立的字节格式化模块，用helper_write_artifact保存format.mjs候选。","input":"export formatBytes(n)：非负安全整数；0为0 B；1024为1 KiB；小数保留一位；非法输入抛TypeError。","files":[]}}
  ]
}
```

```powershell
node "<本技能目录>/scripts/delegate-batch.mjs" "D:/project/work/batch.json" "D:/project/work/batch-results-001"
```

批次必须恰好两个包、显式不同后端、互不依赖；`id` 为1–48位小写字母开头的字母/数字/连字符，不得重名、使用设备名或占用 `batch-plan` / `batch-result`。结果目录必须不存在且父目录已存在。入口先预检两份请求和快照选择，防止一个明显无效的包仍让另一路消耗额度。每路在运行时建立独立不可变快照，分别使用自身总预算和无进展预算。每路结束即保存 `<id>.json`，全部结束后保存 `batch-result.json`；`batch-plan.json` 仅含选路和模式，不复制输入正文。

批次不自动重试、切后端、合并或应用候选；一路失败仍保存另一路结果。Ctrl+C/SIGTERM 传递取消并等待各自清理。批次 `ok:true` 要求两份结果的后端一致、固定模型和调用证据机械通过且保存成功，`semanticAcceptance` 始终为 false。仍应单独执行 `verify-result.mjs` 和语义验收。它只限制本批次每路一个包，不是跨进程的全局调度器；不要在已有该后端任务运行时重复开启占用同一路的批次。

每路都允许主代理根据验证反馈继续派发新会话；切换后端不能重置同一交付物、同一纠错目标的两轮默认上限。需要前一包输出的后续工作先等其独立核验通过，再提供必要结果作为新输入。两路同时成功只证明对应调用完成，不能代替交付验收，也不能据此承诺提速或额度节省。

## 检查结果

失败时读取安全的 `errorDetails`，区分实际记录的错误类型、HTTP 状态与来源。ZCode 不执行额外会话补查，不为补充诊断重跑模型；缺失字段不补造。含义与失败处理见 [错误诊断](diagnostics.md)。

结果是待核验候选；调用完成、格式符合要求和内容可采用应分别判断。分项方法见 [verification.md](verification.md)，可选机械检查命令及 JSON 契约见 [verification-contract.md](verification-contract.md)。契约文件仅供主代理本地检查，不是运行器请求中的新字段，也不必把独立答案交给模型。

结果 JSON 保留 `ok/trust/verificationRequired/modelSelection/sessionId/final`，另含 `backend`、`mode`、`modelRequests`、`toolCalls`、`toolResults`、`toolAudit`、`cleanup`、`runDirectory`、`snapshots` 和 `artifacts`。ZCode 调用还要求 `runtimeEvidenceVerified: true`；这与配置中选择模型不同，表示适配器已核对实际运行证据。`backend` 应与本次请求一致；旧结果缺字段时按 Harness 协议检查，显式不支持的后端不能退回 Harness。结果的 `timing` 是已解析预算、规模依据与进展计时，`timeout` 未触发时为 `null`，触发时含 `kind: "total" | "idle"`、限值和经过时间；旧记录缺少计时字段不代表损坏。

`snapshots` 含原始路径和哈希，便于主代理判断候选所依据的版本；模型工具只按 ID 访问其内容。`artifacts` 含候选文件绝对路径、大小与哈希。失败调用的部分输出和文件也可能存在，不能作为完成结果直接使用。

同一交付物、同一纠错目标默认至多两次反馈续作，每次都是新会话；这是 Skill 的停止条件，运行器没有“整个任务只能调用一次”或“整个对话只有两次”的限制。后续新的实现、测试或需求工作包可以继续由主代理派发，不通过假拆分绕过纠错上限。主代理挑选上轮必要的结论、候选文件和验证失败信息，写入新的 `input/feedback/files`；不自动携带整个会话、不递归委派。发现遗漏可补充新快照，但每次扩大范围都应由主代理主动决定。

Harness 专用 `codex-helper` profile 只允许已知的 base/headless 组合及空用户补丁。不要往此 profile 安装桌面插件；普通桌面插件继续保留在 `desktop`。如果专用 profile 被改动，或 DSH 主目录出现非空的全局 `cordis.patch.yml`，脚本拒绝调用，主代理检查原因后再修复。ZCode 也必须经本适配器的受限工具与模型核验，不用普通桌面会话或直接 CLI 命令绕开控制。任一路认证、工具或模型检查失败时先诊断，不静默转往另一个后端。
