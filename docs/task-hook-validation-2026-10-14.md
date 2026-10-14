# 1.2.0 任务前协作 Skill Hook 验证

本次解决的是技能发现阶段遗漏 `deepseek-helper`：名称与描述没有被选中时，正文中的自动协作规则无法执行。新增 Hook 在每次用户输入进入模型前直接读取并注入完整安装版 Skill；Codex 按原规则判断是否存在值得派遣、材料充分且可独立核验的工作包。简单任务可以不派遣，Hook 不启动 DeepSeek，也不改变两后端的权限、模型、预算或验收。

## 实现

- `UserPromptSubmit` 每次读取当前 `SKILL.md`，不按会话缓存。
- `SessionStart` 匹配 `resume|compact|fork`，在恢复、压缩或 fork 后补回规则。
- 环境 `CODEX_HOME` 优先，其次使用安装器生成的运行配置，再使用默认用户主目录。
- 输入最多 1 MiB，Skill 最多 32 KiB，JSON 输出最多 256 KiB。Skill 名称必须唯一且为 `deepseek-helper`；非普通文件、损坏 JSON/UTF-8、缺失或超限使用固定错误码可见地报告。
- `additionalContextLimit: 0` 配合脚本硬上限，避免完整正文被默认阈值替换成预览。详细参考仍按任务需要读取。
- Hook 仅使用事件名，忽略用户 prompt 与路径字段，不访问对话文件、不保存输入、不联网、不写文件、不启动辅助后端。
- Windows 使用明确的 PowerShell 编码命令，设置 UTF-8、关闭启动进度输出、引用固定 Node/脚本路径并传播退出状态。

实现依据是 [Codex Hooks](https://learn.chatgpt.com/docs/hooks) 的事件、上下文与信任协议，以及 [插件打包说明](https://developers.openai.com/plugins/build/plugins) 的 Hook 清单规则。实际本机协议 Schema 也已通过已安装 CLI 生成核对。

## 当前 Codex 兼容方式

本机 CLI 为 `0.162.0-alpha.17.2`，`hooks` 功能为 stable/true。生产插件 1.2.0 已安装并启用，但插件内 Hook 未被发现；不能将文件安装成功当作触发成功。

使用同一 CLI、配置和 Hook 文件，隔离的未安装插件对照发现：legacy `.codex-plugin/plugin.json` 返回 Hook；root Agent Plugins `plugin.json` 加 `extensions.com.openai.hooks` 返回空 Hook，额外加顶层声明仍为空。root Agent 清单优先于兼容清单，因此当前本机构建不能从本包的 Agent Plugins 路径补回 Hook。管理策略限制与未先发现插件的假设已排除。这是本机观察，不推断其他版本也存在同样问题。

本机采用官方支持的用户级 `hooks.json` 登记。独立入口 `scripts/register-task-hooks.mjs` 仅合并两条本项目 Hook，使用安装脚本绝对路径，保留其他 Hook、混合组和顶层字段；原字节备份、幂等更新、同目录原子发布和并发修改检查均有测试。移除也只匹配本项目的严格命令，不根据文案或仅出现脚本路径删除外部 Hook。

登记不自动写信任。主代理审查代码、测试及实际定义后，依据用户本次要求启用 Hook 的授权，通过原生 `hooks/list` 取得这两条定义的当前哈希，使用 `config/batchWrite` 仅写其信任与启用状态，再确认两条均为 trusted/enabled；没有使用 `--dangerously-bypass-hook-trust`。公开安装说明仍要求使用者审核自己的当前定义。插件级与用户级二选一。

## 验证结果

`node scripts/test.mjs` 的 **220/220 正式离线测试通过，零失败、零跳过**；较 1.1.2 增加 39 项：26 项 Hook 测试、3 项安装测试、10 项登记测试。测试不使用后端账号，不发起模型请求。Skill 也通过官方 `quick_validate.py`；Windows 运行该检查器时显式使用 UTF-8。

新增测试覆盖完整正文、下一次读取反映更新、两事件、中文/空格/单引号路径、UTF-8 字节边界、重复 Skill 名称、错误输入与文件、路径字段隔离、未知事件零文件访问，以及不存在写入、子进程或网络调用。Windows 命令实际通过 PowerShell 执行，stdin、中文 stdout、严格 JSON、完整正文、退出 0 和空 stderr 均通过。登记测试覆盖外部配置保留、混合组、伪装命令、Node 更新、备份、幂等、精确移除、symlink 和无效文件。

独立测试发现的两个边界已修复并复验：重复 `name` 声明原先可被接受；PowerShell 首次模块初始化进度原先污染 stderr。已对未知事件及失败分支做独立只读审查，没有将模型自述作为验收依据。

### 原生任务触发与完整上下文

静态 `codex debug prompt-input` 没有提供已触发 Hook 的证据，因此没有将其记为通过。改用本机 app-server 原生 `thread/start`、`turn/start`，在 ephemeral 线程中连续执行两轮；只连接 `127.0.0.1` 上的临时 Responses 协议模拟端点，返回固定 `OK`，没有真实外部模型或工具调用，不改变生产 provider/model 配置。

| 轮次 | 本轮独立 UserPromptSubmit 完成事件 | 完整安装版 Skill 在 developer context 中 | Skill 路径一致 | 任务完成 |
| --- | --- | --- | --- | --- |
| 1 | 通过 | 通过 | 通过 | 通过 |
| 2 | 通过 | 通过 | 通过 | 通过 |

本次约 6.188 秒，两个 Hook 执行分别约 1.656、1.401 秒。第二轮确有本轮的新完成事件，不能只用第一轮遗留正文证明再次触发。两个请求无 Authorization header，app-server 退出 0，模拟服务已关闭。为隔离用户级 Hook，探针仅在本次临时进程禁用插件、apps、remote plugin 和 memories；未写生产配置，也不能据此声称插件级发现已修复。

每次注入完整规则会增加模型上下文，原生探针也观察到第二轮保留前一轮的 Hook 正文；这不是按会话缓存或只在第一轮加载。当前设计优先保证每次任务都有完整规则，详细参考保持按需读取。

### 本机安装

现有插件身份仍为 `deepseek-monitor@local-personal`。独立文件校验确认 Skill 的 39 个文件及三份插件各 21 个非生成文件与仓库一致，包含隐藏清单；六份 MCP、三份运行配置和三份生成 Hook 配置另行核验。后端路径保留。监看 HTTP 与 MCP/UI 均为 1.2.0，地址及能力令牌不变，已有 53 条监看记录哈希全部保留，watchdog 继续运行。全局用户 Hook 已登记，两条当前定义已信任并启用；重复登记不改文件。按解析后的配置逐项比较，除这两条定义的信任与启用状态之外，其他 Codex 配置及已有 Hook 状态没有变化。

## 验收范围

原生验证证明每个测试轮次实际触发并将完整规则送入模型上下文，没有测试真实模型是否总能作出正确的委派判断。`SessionStart` 的脚本、matcher、注册和信任已验证，本次没有执行真实恢复、fork 或长对话压缩。新会话触发已验收；没有对正在执行本轮任务的旧桌面会话作回溯触发或强制重启。

本次未修改 Harness/OpenCode 运行器的后端行为，未重复真实 DeepSeek 调用；此前两路安装版调用的验证记录仍独立保留。用户暂缓的两项 P1 隔离问题保持原范围。长期压力、不同 Codex 构建或其他系统未在本次验收中覆盖。

脱敏结果见[机器可读摘要](task-hook-validation-2026-10-14.json)。本机配置备份、信任键、路径、会话标识、原始模型上下文及能力令牌未上传。
