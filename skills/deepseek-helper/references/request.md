# 请求与输出

所有模式共用同一入口；旧 `extract/classify/format/draft` 请求继续可用，未指定模式时为 `text`。

```json
{
  "taskType": "review",
  "mode": "propose",
  "instruction": "检查重试逻辑是否符合契约。给出带文件 ID、行号和原始哈希的缺陷候选；如需修复，保存候选补丁和测试。不要运行代码。",
  "input": "已知现象、预期行为和必要任务背景。",
  "feedback": "可选：主代理对上一轮候选的纠正和本轮要求。",
  "files": ["D:/project/src/retry.ts", "D:/project/test/retry.test.ts"],
  "timeoutMs": 300000,
  "maxToolCalls": 24
}
```

`taskType`：`extract`、`classify`、`format`、`draft`、`analyze`、`review`、`debug`、`plan`、`implement`、`test-design`。它描述工作类型，权限仅由 `mode` 决定。`implement` 产生候选实现，不能直接修改项目。

`instruction` 与 `input` 必填字符串；`feedback` 可选。三者合计上限 96 KB。超时默认文本 120 秒、其他模式 300 秒，可显式设置 1–600 秒；退出清理最多额外等待约 7 秒，未确认清理会报告失败。工具调用默认 24 次，最多 80 次。预算用尽后由主代理收尾或重新拆分，不让辅助代理延长自身预算。

`files` 仅用于 `inspect/propose`，是主代理明确选择的绝对文件路径列表，最多 80 个、每个 256 KiB、合计 2 MiB。仅接收 UTF-8 文本，排除二进制、目录、文件符号链接和常见凭据文件名。并非所有允许大小的文件都适合一次提供；优先选择与问题直接相关的最少材料。

## 可用工具

- `helper_list_files`：返回本次快照 ID、文件名、大小与 SHA-256。
- `helper_read_file`：通过 ID 按行读取，每次最多 300 行、约 32 KB。超长单行会截断并列出 `truncatedLines`，不能把截断结果当成完整文件。
- `helper_search_text`：对全部或指定快照进行区分大小写的文字搜索，不执行正则，最多返回 60 条位置。
- `helper_write_artifact`：仅 `propose` 提供；在本次 `artifacts/` 内创建平铺文件名，不允许目录、设备名或替换已有文件。每个最多 256 KiB、合计 1 MiB、最多 12 个。可以提交代码、测试、diff、patch 和文档；创建不等于执行或应用。

快照与候选稿在当前任务 `work/deepseek-runs/task-*/` 中。脚本不会读取主代理未列出的项目文件；通常无需把整个工程或聊天记录交给 DeepSeek。

## 检查结果

结果是待核验候选；调用完成、格式符合要求和内容可采用应分别判断。分项方法见 [verification.md](verification.md)，可选机械检查命令及 JSON 契约见 [verification-contract.md](verification-contract.md)。契约文件仅供主代理本地检查，不是运行器请求中的新字段，也不必把独立答案交给模型。

结果 JSON 保留旧字段 `ok/trust/verificationRequired/modelSelection/sessionId/final`，增加 `mode`、`modelRequests`、`toolCalls`、`toolResults`、`toolAudit`、`cleanup`、`runDirectory`、`snapshots` 和 `artifacts`。

`snapshots` 含原始路径和哈希，便于主代理判断候选所依据的版本；模型工具只按 ID 访问其内容。`artifacts` 含候选文件绝对路径、大小与哈希。失败调用的部分输出和文件也可能存在，不能作为完成结果直接使用。

默认至多两次反馈续作，每次都是新会话。主代理挑选上轮必要的结论、候选文件和验证失败信息，写入新的 `input/feedback/files`；不自动携带整个会话、不递归委派。发现遗漏可补充新快照，但每次扩大范围都应由主代理主动决定。

专用 `codex-helper` profile 只允许已知的 base/headless 组合及空用户补丁。不要往此 profile 安装桌面插件；普通桌面插件继续保留在 `desktop`。如果专用 profile 被改动，或 DSH 主目录出现非空的全局 `cordis.patch.yml`，脚本拒绝调用，主代理检查原因后再修复。
