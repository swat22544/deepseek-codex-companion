# 结果机械校验与本地输出契约

`verify-result.mjs` 不调用模型，不加载委派运行器或监看模块，不修改原始回复，也不读取、应用或执行候选文件。它校验保存的结果记录及主代理提供的有限输出契约。

```powershell
node scripts/verify-result.mjs result.json
node scripts/verify-result.mjs result.json --contract expected.json
```

输入可以是 `delegate.mjs` 的原始结果，或评估工具的 `{ "result": { ... } }` 包装。存在顶层 `ok` 字段时不会转而使用内部结果掩盖顶层失败。

## 独立的判定层

- `protocol.ok`：记录中的 `ok`、守卫激活、模型核验、实际请求次数、固定模型、退出码、完成原因、清理状态、会话与最终回复、工具调用配对都通过。固定模型按后端分别检查：Harness 为 `deepseek-official / deepseek-flash / max`；OpenCode 为 `deepseek / deepseek-flash / max`，还要求 `runtimeEvidenceVerified: true`。旧记录没有 `backend` 时按 Harness 检查。记录本身未经此工具真实性鉴定；它不能替代运行时守卫。
- `tools.ok`：没有记录到 `status: "error"` 的工具结果。工具失败单独列出，即使委派协议正常完成，也使 `mechanicalOk` 为 `false`。主代理检查失败对交付的影响，不能静默忽略。
- `contract.status`：`not_requested`、`passed`、`failed` 或 `invalid`。没有指定契约时，不检查回复格式与内容。
- `mechanicalOk`：上述机械检查通过；它始终伴随 `independentReviewRequired: true`、`semanticAcceptance: false` 和 `trust: "unverified_candidate"`。

CLI 退出码：`0` 为机械检查通过；`1` 为结果不符合检查；`2` 为命令参数、输入文件或契约无效。stdout 是 JSON 报告；输入文件错误写入 stderr。结果文本不会出现在报告中。

`result.exitCode` 是结果文件记录的后端进程退出码，**不是本工具独立观察的委派命令退出码**。主代理还要单独记录实际运行命令的退出状态，确认结果文件来自本次调用，并关联请求中的后端、结果、会话和候选文件。两路分别运行机械检查，不能以一条通过代替另一条。对旧文件运行本工具不能证明会话新鲜度，也不能证明记录未被修改；本工具自己的退出码只表示校验过程的结论。

## 小型契约格式

这不是完整 JSON Schema。未知选项直接判为无效，防止把未实现的约束误当成已校验。

| 字段 | 要求与作用 |
| --- | --- |
| `format` | 必填，仅支持 `"json"`。严格解析完整 `final.text`；不剥离 Markdown 围栏、不截取首段 JSON、不丢弃尾部解释、不自动纠错。允许 JSON 本身的前后空白。 |
| `type` | 必填：`array`、`object`、`string`、`number`、`integer`、`boolean`、`null` 之一。`null`、数组、对象分别判定；数字必须有限。 |
| `requiredKeys` | 可选，仅用于 `object`；唯一字符串数组，要求顶层自有键存在。 |
| `allowedKeys` | 可选，仅用于 `object`；唯一字符串数组，不允许其他顶层键。与 `requiredKeys` 同用时，必须包含全部必需键。 |
| `uniqueItems` | 可选，仅用于 `array`，布尔值；为 `true` 时按 JSON 值检查重复，对象键顺序不影响判等。 |
| `expected` | 可选，完整的预期 JSON 值。必须符合声明类型及其他约束；比较忽略对象键顺序，保留数组顺序、嵌套结构和值类型。 |

不支持嵌套字段类型、正则、数值范围、日期语义、业务约束或源码引用校验。需要这些能力时，主代理编写针对任务的确定性核验脚本。JSON 数值按 JavaScript 的有限 `number` 处理；精确大整数、金额或标识符宜在任务契约中使用字符串。比较遵循 JSON 值语义，`-0` 与 `0` 等价。

例：先由主代理从原始材料独立计算答案，再写入本地契约：

```json
{
  "format": "json",
  "type": "array",
  "uniqueItems": true,
  "expected": ["TASK-2", "TASK-28", "TASK-32", "TASK-36", "TASK-40", "TASK-42", "TASK-48", "TASK-50", "TASK-52"]
}
```

它能够发现漏掉 `TASK-32` 的回复，也能拒绝正确 JSON 后追加解释的回复。**不要把 DeepSeek 自己的答案复制成 `expected`**，这会失去独立核验价值。没有 `expected` 的数组类型与唯一性检查不能证明筛选完整、条件正确或排序正确。

对象形状示例：

```json
{
  "format": "json",
  "type": "object",
  "requiredKeys": ["findings", "uncertainties"],
  "allowedKeys": ["findings", "uncertainties"]
}
```

此契约只证明两个顶层键存在；不会证明缺陷真实、引用准确、两个字段的值类型正确，或没有遗漏。

代码中可纯函数调用：

```javascript
import { verifyResult, validateContract } from './scripts/verify-result.mjs';
const report = verifyResult(savedResult, localContract);
// report.mechanicalOk 仍然不是业务、代码或事实的最终验收。
```

候选代码、解释文字、源码引用、边界示例和测试预期仍需分别核验。监看窗口状态也不参与协议验收；显示滞后不能推翻已保存的有效完成记录，显示成功也不能替代记录检查。
