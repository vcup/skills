# 现行路由的规模、能力与定位核验：DeepSeek / WorkBuddy 七条精确 route

> **本次定向研究。** 核验日期 **2026-11-23 UTC**；只核验本会话实际可选的精确 route 及其厂商一手文档，不评估其它模型家族。本文是**公开资料与研究记录**：只记录可引用的厂商事实、证据分级和通用选型考量，不记录任何部署决定、派单安排或个人运行偏好。现行执行与授权语义仍以[原生代理接入](../NATIVE-AGENTS.md)和[定向选型复核](MODEL-SELECTION-FLASH.md)为准。

研究动机：旧印象（例如把 Flash 记成 V4-Flash 284B/13B）会直接给出错误的成本、上下文和能力预期。凡本文数字与旧笔记冲突，以本文所列一手来源为准，并保留冲突说明。

## 0. 结论摘要（先读这段）

1. **API/route 名称不证明实际 served variant。** 厂商侧模型名、产品侧菜单名、运行时 route 名是三套命名，且至少两处已出现“名字落后于服务”的实证（见 §2.1、§2.2）。
2. **DeepSeek Flash 已不是 284B/13B 的 V4-Flash。** 现行 `deepseek-flash` 官方指向 **DeepSeek-V4.1-Flash-1017**；旧的 284B/13B 属于已退役的 V4-Flash，不能自动迁移到当前 route。1017 的参数量**没有**独立的 1017 单卡数字，只能引 V4.1-Flash 家族卡（见 §2.1）。
3. **Flash 与 Pro 的差异不在参数一项。** Pro 不支持视觉、并发上限 500（Flash 为 2500）、单价约为 Flash 的 3.3–4.4 倍；两者上下文同为 1M、最大输出同为 384K。
4. **`workbuddy/hy4std` 的 “Hy4 Std” 在一手来源里查不到。** 该 provider label 本身**不足以证明底层模型家族或版本**——既不能认定它是官方 Hy4，也不能据别名否认它与某个家族的关系（见 §2.2）。
5. **WorkBuddy 内置模型表的命名滞后**：官方产品文档仍写 `Deepseek-V4-Flash` / `Deepseek-V4-Pro`，而 DeepSeek 已声明旧名退役并由 V4.1-Flash-1017 承接。因此 workbuddy 侧的任何 DeepSeek 名称都不能用来推断版本。
6. **运行时 effort 档位是厂商档位的子集或重映射**，不能按厂商文档的档位名直接点名（见 §3）。
7. **厂商公开 benchmark 要分两类读**：一部分是**独立第三方榜单**（厂商只是引用其公开结果），另一部分是**厂商自建评测**。两者都不能替代本项目内的实测（见 §2.3）。

## 1. 精确 route 清单（本会话实际可选，非推断）

来源：本会话 `list_subagent_models` 逐 provider、逐 model 查询结果（2026-11-23 UTC），不是凭印象填写。

| 精确 route | 运行时显示名 | 运行时 effort 档位 | 是否声称多模态 |
|---|---|---|---|
| `deepseek-official/deepseek-flash` | DeepSeek-V4.1-Flash | off / low / **high（默认）** / max | 文档：支持视觉（见 §2.1） |
| `deepseek-official/deepseek-v4-pro` | DeepSeek-V4-Pro | off / low / **high（默认）** / max | 文档：**不支持**视觉 |
| `workbuddy/hy4std` | Hy4 Std | **仅 high** | 未由厂商一手来源证实 |
| `workbuddy/hy4flash` | Hy4 flash | **仅 high** | 官方 Hy4 flash 卡：文本+图像 |
| `workbuddy/hy3` | Hy3 | **仅 low / high** | 官方 Hy3 卡：未见视觉能力 |
| `workbuddy/glm-5.3-flash` | GLM-5.3-flash | low / high / max | 官方：文本/图像/视频/文件输入 |
| `workbuddy/minimax-m3.1-flash` | MiniMax-M3.1-Flash | low / medium / high / xhigh / max | 官方：文本/图像/视频输入 |

## 2. 逐 route 核验表

“确认程度”分级：**A**=厂商 API 文档与模型卡一致；**B**=仅厂商模型卡或仅 API 文档；**C**=仅产品/第三方页面；**D**=查不到，只有 provider label。

| 精确 route | 当前官方版本 | 确认程度 | 总参 / 激活参 | 厂商上下文 vs 实际 provider 上限 | 模态 / 工具 / 结构化 / effort | 诚实主定位 |
|---|---|---|---|---|---|---|
| `deepseek-official/deepseek-flash` | DeepSeek-V4.1-Flash-**1017**（API 文档 MODEL VERSION 直书） | **A**（版本）/ B（参数，家族卡值） | V4.1-Flash **家族卡**：552B 骨干；激活 8B(prefill)/16B(decode)。1017 单卡未列参数量 | 1M / 最大输出 384K；运行时未暴露上下文档位 → 实际 provider cap **未知** | 视觉 ✓；Tool Calls ✓；JSON ✓；Responses/Anthropic ✓；effort 由 thinking 开关 + 档位控制 | 面向 agentic coding、端到端项目生成的**低成本一线**；官方新闻明确适配 WorkBuddy/CodeBuddy/Harness |
| `deepseek-official/deepseek-v4-pro` | DeepSeek-V4-Pro-**0813**（GA 2026-08-13） | **A**（版本）/ B（参数） | 1.6T / 49B（数字来自 V4 系列卡，0813 未另列参数表） | 1M / 384K；并发上限 **500** | **无视觉**；Tool Calls ✓；JSON ✓；effort low/high/max 官方叙述 | 知识与最难推理、质量优先；单价约 Flash 的 4.4 倍（cache-miss 输入）/3.3 倍（输出） |
| `workbuddy/hy4std` | **未证实**；官方命名体系只有 Hy4 / Hy4-FP8 / Hy4 base | **D**（label 未验证） | 未知。官方 Hy4 家族卡为 770B / 49B(text)+1.23B(vision)，但**不能归到本 route** | 未知 | 未知（不能继承 Hy4 的能力表） | 未知；只能当作“某处未公开说明的 Hy 系列变体” |
| `workbuddy/hy4flash` | Hy4 flash（官方卡，仓库 2026-11-17 建） | **B/C** | 220B（155.5B 骨干 + 63.5B Engram + 0.43B ViT + 0.85B DFly2）；文本 11.3B + 视觉 0.43B 激活 | 官方 1M；本 route 未暴露 | 文本+图像输入；工具解析器 `hy_v4`；effort `high`(默认)/`no_think`；运行时只给 high | 高性价比日常工作模型；官方自述“长程软件工程仍建议用 Hy4” |
| `workbuddy/hy3` | Hy3（295B A21B，Apache-2.0） | **B** | 295B / 21B + 3.8B MTP | 官方 **256K**（明显小于 1M 家族）；本 route 未暴露 | 卡面未见视觉；工具解析器 `hy_v3`；effort `no_think`(默认)/low/high | 同尺寸推理/agent 模型的性价比位 |
| `workbuddy/glm-5.3-flash` | GLM-5.3-Flash | **A** | 320B / 18B | 官方 1M / 最大输出 128K | 视频/图像/文本/**文件**输入，文本输出；Function Calling ✓；结构化输出 ✓；effort 官方推荐 `max`，thinking **不可关闭** | 原生多模态“视觉 coding” + Office/金融/法律成品交付 |
| `workbuddy/minimax-m3.1-flash` | MiniMax-M3.1-Flash | **A** | ~428B / ~23B | 官方 1M；本 route 未暴露 | 文本/图像/视频输入；Interleaved Thinking；effort 5 档（默认 `max`）；thinking 不可关闭 | Agent/工具调用/代码方向的日常高效模型；官方定位“日常主力” |

### 2.1 DeepSeek 两侧的关键细节

- **版本号是硬事实**：`MODEL VERSION` 一列直接写 `DeepSeek-V4.1-Flash-1017` 与 `DeepSeek-V4-Pro-0813`；两者上下文均为 1M、最大输出均 384K、并发 2500 vs 500、视觉仅 Flash 支持。[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/)（2026-11-23 UTC）
- **参数量只能引家族卡**：1017 的[独立模型卡](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017) 只给 benchmark 表、prompt encoding 与采样参数，**没有参数量字段**；552B 骨干 / 8B·16B 激活出自 [DeepSeek-V4.1-Flash 家族卡](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash)。1017 卡自述为“a minor update to DeepSeek-V4.1-Flash”，因此 552B 应写作**家族值**，不应直接归为该版本已核参数。（2026-11-23 UTC，经镜像读取）
- **旧名退役已被官方明写**：`deepseek-v4-flash` 与 `deepseek-v4-flash-vision-exp` “仍被接受，但对应模型已退役，其请求由 DeepSeek-V4.1-Flash-1017 服务并按 Flash 价计费”。这既解释了为什么旧名不能反推规模，也解释了 §2.2 的产品侧命名滞后。[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/)（2026-11-23 UTC）
- **Pro 的参数来自 V4 系列卡**：V4-Flash 284B/13B、V4-Pro 1.6T/49B。[DeepSeek-V4 系列卡](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro)（2026-11-23 UTC）
- **并发是实操约束**：Flash 2500、Pro 500，账户级计算，超限 429。[Rate Limit & Isolation](https://api-docs.deepseek.com/quick_start/rate_limit)（2026-11-23 UTC）→ 高并发 fan-out 时 Pro 更容易撞限。
- **成本结构**：off-peak 为 peak 的 50%；peak 为 UTC 周一至周五 01:00–04:00 与 06:00–10:00（排除中国法定节假日）。同一任务换时段可省一半，这与模型选择无关但同等影响预算。[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/)（2026-11-23 UTC）
- **官方适配声明**：1017 版“为 DeepSeek Harness、Tencent CodeBuddy、WorkBuddy 等优化”，并称在性能与成本上是 Pareto 改进。[V4.1-Flash-1017 发布](https://api-docs.deepseek.com/news/news261017/)（2026-11-23 UTC）

### 2.2 `hy4std` 的别名为何无法定案

已尝试的一手路径与结果（均 2026-11-23 UTC）：

| 检查 | 结果 |
|---|---|
| 官方仓库 `Tencent-Hunyuan/Hy4` | 存在；README 模型链接只有 **Hy4 / Hy4-FP8 / Hy4 base**，无 “Hy4 Std” |
| 官方仓库 `Tencent-Hunyuan/Hy4-flash` | 存在；模型链接只有 Hy4 flash / -FP8 / -base |
| 官方仓库 `Tencent-Hunyuan/Hy3` | 存在；Hy3 / Hy3-FP8 |
| GitHub 组织内检索 “Hy4” | 3 个仓库：Hy4、Hy4-preview、Hy4-flash；**没有 std 后缀的模型仓** |
| WorkBuddy 官方《模型配置》内置模型表 | 列 `Hy4 preview`、`Hy3`、`GLM-5.3`…`Deepseek-V4-Flash`、`Deepseek-V4-Pro`；**没有 “Hy4 Std”，也没有 Hy4 flash**（该页面对 11-16 新模型滞后） |
| `hy.tencent.ai` 模型主页 | 返回空壳页，无可提取规格 |

**准确的结论边界**：`hy4std` 是一个**未公开文档化的 provider label**。它可能对应官方 Hy4、Hy4-preview、某次量化/蒸馏产物，也可能对应与 Hy 家族无关的其它后端。

因此可证的只有两点：

- **不可证**：底层模型家族、版本、参数量、能力上限。（“查不到 std 后缀”只说明官方未以该名发布模型，**不说明**它属于或不属于某个家族。）
- **可证**：该 label 不能作为“已核实的官方 Hy4”引用；任何基于它的能力或规格陈述都缺一手依据。

由此派生的评测含义：以该 label 产出的结论仍是**非作者的第二意见**（在“不是产出该代码的那个人”这一点上有效），但其“来自不同模型家族”这一属性**无法认证**——跨族独立性需要底层 family 可核实才成立。这属于**证据身份不足**，与训练数据/训练方法上的独立性无关，本文不对后者作任何推断。

### 2.3 参数、“flash 字样”与 benchmark 的正确读法

**名称与参数不能排序：**

- GLM-5.3-**Flash** 是 320B/18B 且原生多模态；Hy4 **flash** 是 220B/11.3B。两者“flash”档位相差一代规模，命名不构成可比性。
- DeepSeek Flash 552B 骨干（家族值）比 Pro 1.6T 小，但 decode 激活 16B 与 Pro 的 49B 差距远小于总参差距；用总参除算“能力比例”会得出错误预期。
- Hy3 的 295B/21B 与 Hy4 flash 的 220B/11.3B 相比，前者总参更大但上下文只有 256K。**参数、上下文、模态、effort 是四个独立维度**，任何单指标排序都会误导。

**benchmark 分两类，不能一律说成“厂商自评”：**

| 类别 | 本文涉及例子 | 该怎样引用 |
|---|---|---|
| 独立第三方榜单 / 公开基准 | Artificial Analysis Intelligence Index（GLM 文档引用其 57 分）、HLE、Terminal-Bench 4.0、DeepSWE v1.1、ProgramBench、NL2Repo-Bench、Automation-Bench、Agents' Last Exam、OSWorld 2.0、CyberGym、MMMU-Pro 等 | 属公开基准，但**厂商报的是自家跑的分数**，harness、采样预算、上下文长度、judge 模型各不相同；引用时必须带 harness 与设置，不能当作同条件横评 |
| 厂商自建评测 | 腾讯 WorkIndex / 金融专家盲评 / TenureTrail、智谱 Z.ai Code Bench、MiniMax BankerToolBench、DeepSeek 内部 base 评测框架 | 只能当**厂商自我定位**的证据，不能作外部结论 |

**唯一被双方共同引用的第三方综合指标**是 AA 智能指数（智谱引用它给 GLM-5.3-Flash 打分）。即便如此，它仍不是本项目内实测。

**共同的限制**：以上两类都不能替代本项目内的实测；本项目的采纳判断只能由可执行证据（测试、diff、运行结果）支撑。

## 3. 上下文与 effort：route 层看不到的那一半

- **上下文**：厂商文档给的是模型上限（DeepSeek 1M、GLM 1M、MiniMax 1M、Hy4 1M、**Hy3 256K**）。运行时 `list_subagent_models` **不返回** context 上限，workbuddy 侧还存在“默认/适中/超长”档位概念（官方文档称“以界面实际显示为准”）。因此：**“模型支持 1M” ≠ “本次调用可用 1M”**。需要真长文时，应按实际截断/失败来判定，而不是按卡面假定。
- **effort 只能按运行时档位点**：
  - DeepSeek 官方接受 `minimal/low/medium/high/xhigh/max/ultra` 并映射到 low/high/max（medium、xhigh→high，ultra→max），thinking 默认开启且默认 high；运行时只给 4 档 → **`off` 是真实关闭思考，`low`≈厂商 low，`high`=厂商 high/medium/xhigh，`max`=厂商 max**。[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)（2026-11-23 UTC）
  - Hy3 官方支持 `no_think`（默认）；运行时只给 low/high → **运行时无法表达“不思考”**。
  - GLM-5.3-Flash 官方称 thinking “强制不能关闭”，推荐 `reasoning_effort: max`；运行时给 low/high/max。
  - MiniMax-M3.1-Flash 官方 5 档且默认 `max`，显式关闭思考会返回 400；运行时 5 档与之一致。
  - ⇒ 任何按 route 描述的行为，都**只能按运行时可表达的档位**陈述，否则不可执行。

## 4. 证据分级自检（本文没有证明的事）

- 本文证明的是**厂商文档层面的模型身份、规模、模态、上下文与 effort 语义**，以及**运行时暴露了哪些 route 与档位**。
- 本文**没有**证明：这些 route 实际 served 的权重版本；实际可用上下文；实际吞吐/延迟；实际质量。只有真实请求 trace 或 provider 侧记录才有资格证明后者。
- `workbuddy/hy4std` 的底层家族与版本**均未验证**（§2.2）。
- 本文**没有**做跨模型独立横评；引用 benchmark 时已按 §2.3 区分第三方基准与厂商自建评测。

## 5. 通用选型考量（非规范，非本项目决定）

以下是**从上述事实推导出的通用判断维度**，供任何人按自己的任务与成本约束自行权衡；它们不是本项目的规定，也不含阈值或强制升级条件。

- **能力与成本的权衡**：同一家族内，较小/较快的 route 通常已覆盖日常实现与测试类工作；更大 route 的收益主要体现在知识密度、最难推理与长程一致性上，而单价与并发限制同时变差（Pro 并发 500 对 Flash 2500）。
- **模态是硬约束而非偏好**：`deepseek-v4-pro` 明确不支持视觉。需要看图/看渲染结果的任务，应从一开始就选原生多模态 route，而不是先试再回退。
- **上下文要按实测校准**：厂商上限不等于可用上限，且家族内差异很大（Hy3 256K vs 其余 1M）。长文任务宜以实际截断行为判断，而不是按卡面假定。
- **effort 的收益随任务有界性变化**：有界、可验证的任务增量收益有限；开放式设计、跨模块因果、证据冲突类任务收益更明显。选择时应判断任务性质与已有证据，而非套用固定档位。
- **跨族第二意见的价值取决于可核实的身份**：只有在底层 family 可核实时，“不同家族”才成立；未文档化的 label 只能提供“非作者”这一层价值。
- **成本还受时段影响**：DeepSeek off-peak 为峰值 50%，调度本身可显著改变预算。

## 6. 边界声明

- 本文不含任何部署决定、派单安排、个人运行偏好或凭证；相关内容按[研究目录保存规则](README.md#保存规则)留在私有运行档案。
- 本文不改产品代码、配置、`activeAgents`、live profile 或用户全局设置，也不改 Git。
- 本文未修改[研究目录索引](README.md)的表格；索引登记留给文档所有者。

## 7. 来源

全部访问日期 **2026-11-23 UTC**。

| 来源 | 用途 | 类型 |
|---|---|---|
| [DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/) | 版本号、上下文/输出、视觉有无、并发、单价、旧名退役 | 厂商 API 文档（一手） |
| [DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode) | thinking 默认、effort 映射表、各模型 top_p 行为 | 厂商 API 文档（一手） |
| [DeepSeek Rate Limit](https://api-docs.deepseek.com/quick_start/rate_limit) | 账户级并发 2500/500、429 | 厂商 API 文档（一手） |
| [V4.1-Flash-1017 发布](https://api-docs.deepseek.com/news/news261017/) | 官方对 Harness/CodeBuddy/WorkBuddy 的适配与定位 | 厂商公告（一手） |
| [V4-Pro GA 发布](https://api-docs.deepseek.com/news/news260813/) | Pro GA 日期、effort 三档叙述 | 厂商公告（一手） |
| [DeepSeek-V4.1-Flash-1017 单卡](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017) | 1017 benchmark 表、采样参数；**无参数量字段**；自述为 minor update | 厂商模型卡（一手，经镜像读取） |
| [DeepSeek-V4.1-Flash 家族卡](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash) | 552B 骨干、8B/16B 激活、CED、45T、effort 1–100 | 厂商模型卡（一手，经镜像读取） |
| [DeepSeek-V4 系列模型卡](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro) | V4-Flash 284B/13B、V4-Pro 1.6T/49B、三档思考 | 厂商模型卡（一手，经镜像读取） |
| [Tencent-Hunyuan/Hy4](https://github.com/Tencent-Hunyuan/Hy4) | 770B/49B、1M、视觉、DFly2、`no_think`/`high` | 厂商仓库（一手） |
| [Tencent-Hunyuan/Hy4-flash](https://github.com/Tencent-Hunyuan/Hy4-flash) | 220B 构成、11.3B 激活、1M、WorkIndex 定位 | 厂商仓库（一手） |
| [Tencent-Hunyuan/Hy3](https://github.com/Tencent-Hunyuan/Hy3) | 295B/21B、**256K**、effort 档位 | 厂商仓库（一手） |
| [GLM-5.3-Flash 文档](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash.md) | 320B/18B、1M/128K、四模态输入、FC/结构化、effort 建议、AA 指数引用 | 厂商文档（一手） |
| [GLM 思考模式](https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode.md) | thinking 强制开启、interleaved/preserved | 厂商文档（一手） |
| [MiniMax 模型调用](https://platform.minimax.cn/docs/guides/text-generation) | 1M、effort 5 档默认 max、thinking 不可关 | 厂商文档（一手） |
| [MiniMax-M3.1-Flash 模型卡](https://huggingface.co/MiniMaxAI/MiniMax-M3.1-Flash) | 428B/23B、模态、各基准的 harness 与 judge 说明 | 厂商模型卡（一手，经镜像读取） |
| [MiniMax 模型列表](https://platform.minimax.cn/docs/faq/models) | 在服模型与 M2.5/M2.7 下线迁移 | 厂商文档（一手） |
| [WorkBuddy 模型配置](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model) | 内置模型表、三档模式、上下文档位、下线自动切换 | 产品文档（一手，但是产品侧） |
| [WorkBuddy 更新日志](https://www.codebuddy.cn/docs/workbuddy/Changelog) | 无 `hy4std` 相关条目 | 产品文档（一手，反证） |
| 本会话 `list_subagent_models` | 精确 route 与 effort 档位 | 运行时观察（一手） |

**旁证但未采用**：二手媒体/百科对 Hy4 flash “224B 总参”的说法与官方卡（155.5 + 63.5 + 0.43 + 0.85 ≈ 220.3B）不一致，本文以官方卡为准，不引用二手数字。

## 8. 与既有笔记的关系

- [定向选型复核](MODEL-SELECTION-FLASH.md) 解决的是**能不能/怎样选 route**（授权、白名单、effort 继承）；本文解决的是**选定之后那条 route 意味着什么**（规模、能力、上限、定位）。两者互补，不互相替代。
- 本文不推翻该笔记关于“请求参数不是 actual request 证据”的处分；本文同样没有采集真实请求 trace。
