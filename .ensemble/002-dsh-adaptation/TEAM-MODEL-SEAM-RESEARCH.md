# 旧具名 Team 的逐成员模型配置 seam：源码与 Git 历史核实

日期：2026-11-16（UTC）。任务：task-5，execution。只研究，未安装、修改或运行产品实现，未启动实验代理，未切换 checkout，未运行源码测试。本文的测试证据均为阅读已有断言，不是本轮执行结果。

## 结论

**用户指出的是实质缺口：当前具名 Team 不能仅因新版普通 subagent 能选模型，就视为已满足逐成员选型。** 本轮读取的当前 `spawn_teammate` schema 只有 `name / description / prompt / context`。与它逐字对齐的历史实现中，底层 subagent 已支持 `agentOptions`，但 Team 的 `SpawnTeammateRequest` 没有 `agentOptions / agentPreset`，Team 到 subagent 的调用也没有转交它们。因此是 **Team 工具面和 Team 创建请求/转发层共同缺口**，并非 LLM 引擎完全缺少该能力。[工具 schema][O-tool-spawn]、[Team 请求][O-request]、[转发实现][O-spawn]、[subagent 请求][O-start-types]

**专用 ensemble 插件有明确价值，但“注册一个选模型 provider 即可”在该历史 Interface 下不成立。** 可以让插件负责逐成员 assignment、模型/effort/preset 选择及授权校验，再由原生 Team 创建成员；要完整做到这一点，旧 Team 至少需要一个有类型、逐请求的配置传递 seam。保留 Team 的名字、child id、roster、消息、恢复、任务和取消，不建立 ensemble 成员名单或第二执行器。这是设计建议，不是当前实例已支持的能力声明。

**直接从插件调 `ctx.subagents.startActivation()` 会产生原生 subagent，但在旧 Team 中不会自动成为具名 teammate。** 旧 membership 明确排除没有 durable roster 行的 provider child，已有测试专门断言这点。[实现][O-membership]、[测试][O-membership-test]。新版 checkout 已改为 subagent 树共享 Team 任务板，是另一套 Interface，不能反推旧实例。[新版 Team][N-team]、[迁移说明][migration]

## 1. 版本与证据边界

| 证据层 | 本轮实际核实 | 可以推出什么 |
|---|---|---|
| 当前运行工具 | `tool_describe(spawn_teammate)`：具名 durable、Lead-only，参数为 `name/description/prompt/context fresh或fork` | 本会话工具面没有逐成员 LLM route、effort 或 preset 字段；没有进行越过 schema 的调用 |
| 只读 checkout | [deepseek-harness checkout](/home/vcup/projects/deepseek-harness)，HEAD 为 `39163dd30f703a79079e2d2446545cff3c453738`，origin 为官方仓库 | 固定新版源码证据，不能当当前运行二进制的版本证明 |
| 删除旧 Team 的提交 | [`11479fca1346d12b4053a4be95c3b0983d1ad855`](https://github.com/deepseek-ai/deepseek-harness/commit/11479fca1346d12b4053a4be95c3b0983d1ad855)，`refactor(team): reuse subagents with id-only addressing` | 删除 `spawnTeammate`、旧 roster 和 Team 私有控制 Interface 的历史变更 |
| 删除前的历史基线 O | 上一提交的父提交 [`1e477804c638c57118e90f524b96e95a3764d802`](https://github.com/deepseek-ai/deepseek-harness/commit/1e477804c638c57118e90f524b96e95a3764d802) | 下文旧实现的全部判断固定到此提交；工具 schema、具名寻址、Team policy 与当前公开工具形态一致，但这仍不证明运行实例就是此提交 |
| 新版基线 N | `39163dd30f703a79079e2d2446545cff3c453738` | 只用于解释迁移方向及可复用的授权/能力预检，不覆盖旧版事实 |

历史定位使用 `git log --all -S 'spawnTeammate' -- '*.ts'`，并对当前 Team 入口使用 `git log --all --follow`；再用 `git show` 读取固定 Git 对象，没有 checkout、导出历史文件或修改源树。发现旧文件位于 `packages/experimental/agent-team` 和 `packages/experimental/tool-agent-team`，不是当前 `packages/team`，也不是根级 `packages/agent-team`。checkout 原有三个未跟踪 repair 目录未读取、未修改。

当前安装构建的精确提交、加载的 Team/模型插件、Session 允许路由、实际支持的 effort、preset 定义均未在本轮确认。下文“已支持”只指明确标注版本的源码 Interface；“建议”不声称已安装或可立即调用。此前的[综合研究](/home/vcup/projects/vcup-skills/.ensemble/002-dsh-adaptation/INTEGRATION-RESEARCH.md)与[Team 研究](/home/vcup/projects/vcup-skills/.ensemble/002-dsh-adaptation/DSH-TEAM-RESEARCH.md)主要覆盖新版；本笔记补旧具名 Team 的缺口，不能将两者混成同一实现。

## 2. 旧 Team 创建链：具体在哪一层断开

| 层次（版本 O） | 真实字段与行为 | 对逐成员配置的含义 |
|---|---|---|
| `spawn_teammate` 工具 | 模型传名字、description、prompt、context | prompt 已逐成员可设；其他配置不在 schema 中 |
| 工具部署配置 | `freshProvider='spawn'`、`forkProvider='fork'`，按 context 二选一 | 是整个工具实例的静态执行 backend 选择，不是 LLM provider/model；不是每次传入的模型配置 |
| `SpawnTeammateRequest` | `name, description, prompt: ContentBlock[], context, provider, signal` | **service 层已有逐请求 execution provider**，自定义工具可给不同注册名；但没有 `agentOptions`、`agentPreset` |
| `TeamRoster.spawnAdmitted` | Lead 鉴权、名字校验/预留、创建 childId，先 flush provisioning，再 `startActivation` | 原生 Team 仍应拥有该过程；失败的名字也永久保留，不宜在此之后才发现可预检的选型错误 |
| Team → subagent | `provider=request.provider`，`childId` 已预留；`request` 只传 `prompt,parent`；`delivery='parent'` | 即便给 JS 请求附加未声明配置，当前实现也不会自动 forward |
| 原生 subagent | `SubagentStartRequest` 已有 `agentOptions`、`agentPreset`、cwd/schema/depth；local manager 合并请求与父选项 | 缺的是到达此 seam 的合法通道，不必重写 agent loop 或持久会话 |

以上分别见[工具与配置][O-tool]、[Team 请求类型][O-request]、[Team provisioning/forward][O-spawn]、[subagent 请求][O-start-types]、[manager 选项合并][O-manager-create]。

`context` 与模型不是同一维度。fresh 不带父对话；fork 只复制截至最后 `turn/end` 的前缀，首次捕获后成为子会话自己的持久历史。两个 fresh 成员完全可能使用同一模型。旧 Team 的 context 在 roster 中保存、由工具用来选 backend；Team service 没有验证 `context` 是否与任意自定义 backend 的 `inheritsParentContext` 一致。自定义入口必须保证这一对应，不能任意标 fresh 却路由到 fork。[fresh][O-fresh]、[fork][O-fork]、[Team 转发][O-spawn]

## 3. 静态/动态 provider 能否补上，而 Team 保持身份与恢复

结论要区分“能注册”与“该注册能够改变什么”：

| 候选办法 | 源码判断（版本 O） | 结论 |
|---|---|---|
| 注册另一个 local provider，再由自定义工具逐次调用 `agentTeams.spawnTeammate(provider=...)` | registry 支持按名字注册；Team 请求确实接收 provider；通过 Team 创建仍有原生 roster | **能选择创建 backend，不能据此宣称能逐成员选 LLM** |
| 为每个模型注册一个 provider，设置 `agentRouteDefaults` | 字段契约要求 consumer 合并；普通 subagent 工具会读它，Team 不读它；manager 也不自动合并 | **仅注册静态 defaults 无效**；若上游 Team consumer 增加合并/预检可行，但比直接传 `agentOptions` 更间接 |
| 动态注册 provider，闭包保存本次 model/effort/preset，在 `prepareContinuable` 中返回它们 | 输入只含 cwd/sessionId/parent/signal；返回 Interface 只允许 seed；manager 在调用 prepare 前已合并选项并构造 descriptor | **没有受支持的配置返回通道**；额外返回字段不被 manager 消费 |
| 自定义 provider 实现外部 `start()`，内部自己调选型引擎 | Team 总会预留 childId；`startActivation` 对预留 id 强制要求 `prepareContinuable` | **external-only provider 会被拒绝**；它也没有原生 local cold continuation，不能代替当前 durable teammate |
| provider 内另开一名 subagent 或插件直接 `startActivation` 后自行记名 | 外层 local 成员与内层工作者会是不同身份，或者普通 child 根本不在 Team roster | **不满足同一个原生成员身份**，还会分裂消息、恢复、取消与配置事实 |
| 改 parent.options、暂改全局 model、覆写 manager/provider 方法、事后补 Team journal | registry 支持并发 starts；manager 有明确配置快照与身份事务；这些不是本文核实的公开配置 seam | **不采用**；有并发串扰、descriptor 不一致、恢复失真或复制 Team 事务的风险 |

证据：[registry 注册/移除][O-registry]、[provider 与 seed-only 契约][O-provider]、[reserved childId 限制][O-activation]、[manager 顺序][O-manager-create]、[普通工具合并 defaults 与预检][O-model-tool]。

静态或动态 provider 的注册本身是合法扩展机制，但其目的在这里是控制“如何贡献 fresh/fork 的创建输入”，不是选择 local child 的全部配置。冷恢复不再 dispatch 最初 provider，所以不能把必须重建的模型决策只藏在临时 provider 闭包中。[O-restore] 也不建议为了两种模型发明两套自定义 backend；已有 spawn/fork 已经是适用的 Adapter。

## 4. prompt、preset、model、effort：应分别落在哪里

| 维度 | 旧 Team 现有能力 | 正确 seam / 限制 |
|---|---|---|
| 本次任务 prompt | 已逐请求传 `ContentBlock[]` | ensemble 插件可生成、审查或组合 assignment，再传原生 Team；后续 `send_message` 是继续上下文，不能回写成一次新的独立首轮 |
| persona / 工具组合 / 稳定角色指令 | Team 创建请求没 preset 字段 | fresh 的 subagent 已支持独立 `agentPreset`；建议 forward 原生 preset，不另设一份 persona/tool runtime |
| LLM provider + model | subagent 已支持，Team bridge 不支持 | 应是经授权解析的每请求 `agentOptions.provider/model`；execution provider 名不能冒充 LLM route |
| reasoning effort | subagent 已支持 `AgentOptions.reasoningEffort`，descriptor 已有对应字段 | 必须交给模型 Adapter 的真实 capability 校验；prompt 中要求“更深入”不是 provider effort 参数 |
| fork + 独立 preset | 原生 fork `agentPreset=false`，service 也拒绝 inheritsParentContext 的独立 preset | 在最小方案中明确不支持；允许 fork 改 LLM route/effort 不等于可以任意换工具/系统组合 |

来源：[请求与 capability][O-start-types]、[provider 契约][O-provider]、[fresh][O-fresh]、[fork][O-fork]、[capability enforcement][O-capabilities]、[子 composition][O-child-composition]。即便 preset 与父同名，显式选择对 fork 仍是被拒绝的独立 preset 请求；该约束应显示给调用者，不能静默忽略。

## 5. 模型授权和 effort 预检不能由工具包装“顺带获得”

**权限、路由可用性、effort 支持是三件事。** 能访问 `ctx.subagents` 不等于模型已获准任选 LLM；`capabilities.agentOptions=true` 只说明 backend 接收这种配置，不说明选定路由已授权或实际支持指定 effort。[activation 入口][O-activation]、[capability 检查][O-capabilities]

版本 O 的普通 subagent 工具在安装时读取/继承 Session 的 `subagent/model-selection-policy`，从 Host 设置为新根 Session 捕获允许的具体 provider/model；模型请求必须启用选择，显式路由按 policy 检查。配置层 defaults 是另一个受信任来源。执行顺序是 preset 解析 → 合并 route → 授权 → `llm.resolveCallConfig` 预检 → 检查 provider 注册未变 → `startActivation`。旧 Team 的创建链没有经过这些步骤。[执行顺序][O-model-tool]、[policy 来源][O-model-policy]、[路由解析][O-model-selection]

版本 N 改了字段及省略语义，不能照搬旧配置名：普通工具使用 `modelSelection/modelDiscovery`；显式选择要求 provider+model 都给，即使只想选 effort 也要带 route；policy 缺失时显式选择仅限当前父 route，因此启用选择后，同父 route 上选择合法 effort 不要求跨模型授权；显式 route 省略 effort 会清除兼容的父 effort，使用模型默认。版本 O 在启用选型后允许 effort-only，并且未变 route 时的 effort 合并规则不同。[新版配置][N-tool-config]、[新版解析][N-selection]、[旧版解析][O-model-selection]。这进一步说明仅凭当前工具名字不能确定底层版本。

建议采用一份原生授权来源、一条共享解析路径：

1. 从当前 Session 的实际 policy 和可用 Adapter 目录发现允许 route/effort，不从 prompt 推断授权，也不把模型输入放进“可信配置 defaults”来绕过 allowlist。
2. 在预留 Team 名字前，校验 execution provider 是 local/continuable、fresh/fork 对应正确、preset 可选且被允许，解析完整 LLM route 和 effort 意图。
3. 使用 LLM Module 进行 exact-model 能力预检。版本 N 的 `resolveCallConfig` 会验证 adapter metadata、拒绝不支持的 effort、不做 clamp/alias，并物化默认值；但这是独立查询，不绑定后续实际 dispatch。[N-llm]
4. 向 Team 传不可变的逐请求选项，让 native manager 构造 descriptor 和 child，保持取消信号贯通；并发两个创建不能靠共享可变“当前模型”槽位传递配置。
5. 真实请求发出时继续使用原生 LLM dispatch 的校验和记录；不能将一次成功预检当作所有后续恢复都永远可用的保证。

当前可复用逻辑位于普通工具的内部相对导入中；[旧工具入口][O-tool-imports]与[新版包 exports][N-tool-exports]都不足以构成一个明确、稳定的“授权后启动 Team 成员”公共 Interface。虽存在 `./src/*` exports，也不能把机械源码路径当成跨版本稳定的 policy 服务。可将选择/授权/预检提炼为受支持的公共 seam，让原生 Team 工具与 ensemble Consumer 共用；不要复制一份随版本漂移的 allowlist 规则，也不要声称直接 `startActivation` 自动继承这些规则。

## 6. descriptor、实际模型和冷成员可观察性

版本 O 的 manager 在首次 await 前调用 `resolveChildAgentOptions(parent, request.agentOptions, depth)`，保存 `agentProvider / agentModel / agentReasoningEffort` 到 descriptor，然后调用 provider prepare。父值优先取最近 `request/header.config`，不是一概使用创建时 options；改 route 未给 effort 时会清掉父 route 的 effort。[创建顺序][O-manager-create]、[父选项合并][O-option-merge]

这套持久化足以支持**显式传入的选型**冷恢复，已有测试断言 model/effort 写入 descriptor、恢复后仍使用该模型，并检查实际 `request/header` 的 effort。[O-route-test] 因而仅让 Team bridge 正确 forward 显式选项，不需要另建 ensemble 配置存储。

但不能把 descriptor 一律称为“实际运行模型证明”：

- descriptor 保存的是创建时合并后的**声明配置**。字段可以缺省；普通工具预检返回 `void`，没有把 LLM Adapter 物化的默认 effort 回填给 manager。[descriptor][O-descriptor]、[预检实现][O-model-selection]
- 默认 effort 缺省时，恢复可以重新取 Adapter 当时的默认；`maxTokens` 和输出 schema 刻意不是持久配置。不能仅凭 descriptor 宣称预算、默认值和环境完全重现。[O-descriptor]
- 旧 `roster.list` 用 `live?.options.model ?? root.options.model`。子成员冷却后甚至会展示 Lead 当前 model；这是展示回退，不是读取子 descriptor，也不是最后一次请求。逐模型 ensemble 不能据此记录实际选型。[O-roster-view]
- descriptor 的 `provider` 是执行 backend；LLM provider 是 `agentProvider`。只记录 `spawn` 或 `fork` 不回答使用了哪个模型。[O-descriptor]

建议观测语义至少区分：**请求的配置、已持久化的创建配置、实际 request/header 的 route/effort**。尚未发模型请求时写“尚无实际调用”，冷成员不可用 Lead fallback 猜值。若要求跨恢复严格固定实际 effort，应在创建前有意解析并保存具体值；是否固定默认是产品语义选择，不能无声改变继承行为。若后续允许原地换模型，还需由 native Session 定义新的持久选择事件与恢复规则；当前 send_message 不携带模型配置，不建议插件直接改 live Agent。

“实际模型”最多表示可观察的 provider/model 路由和 Adapter 请求记录，不证明服务商背后的模型权重或不同别名必然异构。

## 7. 冷恢复、失败和取消：必须保留的原生行为

| 问题 | 版本 O 的证据 | 插件设计约束 |
|---|---|---|
| 具名创建如何落盘 | provisioning 先写 Lead log；child 的初始 prompt 确认落盘后才写 active；失败保留名字 | 仍调用原生 Team，不自己先 spawn 再“补名单”或盲重试同名创建。[O-spawn] |
| 未终结 provisioning | 校验持久 child 的 parent、continuable descriptor、execution provider 和初始 user message；只恢复 active/failed 状态，不重跑原 assignment | extension 不应另做重启任务队列；配置事实应进入 native descriptor/Session。[O-reconcile] |
| cold message | Team 以 Lead 的授权及真实 sender 身份交给 subagent；manager 校验 lineage 后读自己的 descriptor | 继续用 `agentTeams.sendMessage`，不能另开同名 Session 替换。[发送][O-team-send]、[恢复][O-restore] |
| provider 移除 | local 冷恢复不再次 dispatch provider；已有测试卸载 provider 后继续成功 | 选型不能只保存在 provider 实例、临时 Map 或注册名编码中。[O-retired-test] |
| preset | 显式独立 preset 在 child 中记录选择；恢复读当前 projected preset；缺失/broken 时失败 | 保留 preset id 和 native selection，不声称保存旧 preset revision。[实现][O-restore]、[测试][O-preset-test] |
| 旧版继承 preset | 未显式选择的子恢复仍通过 `composeFrom(parent.ctx)` 加入父当前 generation | 旧 Team 通常没有独立 preset，不能套用新版“总按子 saved preset 恢复”的结论。[恢复输入][O-restore]、[composition][O-child-composition] |
| 权限 | 首次委派捕获已组合的 sandbox/permission 配置；存在 approval 服务时 pin 为 never；日志写在 fork seed 后，恢复重放 | 配置插件不能借 model/preset 放宽 delegated 权限；不用全局权限临时切换。[O-permission] |
| `interrupt` | 只取消目标当前 turn，保留 pending inbox；不释放 task owner，不意味着执行已停止或任务成功 | 使用原生 Team interrupt；取消动作与验收状态分开。[实现][O-interrupt]、[测试][O-interrupt-test] |
| teardown/dispose | **旧版** dispose 会释放 owned descendants、取消 pending materializations；Team 卸载关闭 admission、等待在途操作、drain roster children，有超时 | 不把新版 dispose 的非递归语义倒灌旧版；不用卸载整个 Team 作为停止单次 ensemble 的技巧。[dispose][O-disposal]、[Team 卸载][O-service-disposal]、[超时][O-lifecycle] |
| 请求 signal | 接受前取消用于回滚；接受后普通 delivery 不随 caller 放弃而撤回；Team 初始创建还要做 durability checkpoint，checkpoint 失败会 drain child | 不能简单声称“工具被取消就所有成员已停止”。由原生事务决定接收/失败边界。[创建][O-spawn]、[接收后取消测试][O-signal-test] |
| 崩溃后消息 | accepted 但未进入日志的消息不自动 replay；最终 flush 也可能失败而使持久状态 stale | durable 成员不等于 exactly-once 或自动恢复所有工作；先核对原生状态和产物。[消息测试][O-unlogged-test]、[flush][O-final-flush] |

新版 N 冷恢复改为 root/tree 授权和只恢复目标，使用 saved projected/header preset；它还把 ownership/取消改为另一套树生命周期。[新版恢复][N-restore]、[迁移说明][migration]。此处不推断当前运行实例采用其中哪项内部实现。

## 8. 建议的最小上游扩展，而非另造执行器

以下是设计建议，未实现：

| 变更 | 是否必须 / 为什么 | 不需要一起改什么 |
|---|---|---|
| 扩展旧 `SpawnTeammateRequest`，接收受限的 LLM options 与 `agentPreset`，原样 forward 给 native activation | **若保留旧具名 Team 且要逐成员配置，这是必要 bridge**。现有 request 只有 backend provider；已有 manager 可完成显式 route/effort 持久化 | 不需要新 agent loop、subagent backend、roster 或独立恢复数据库 |
| 模型面入口暴露选择 | 可扩展原生 `spawn_teammate`，也可由独立 ensemble 工具 Consumer 调同一 Team seam；不替换 service 方法 | 无需更名或重写 send/list/task/wait；普通 prompt 已能逐成员传 |
| 共享授权/预检 resolver 或等价的受支持公共 Interface | **对模型可自主选择的入口，授权及能力预检是必要行为**。其公共化是避免复制工具内部策略的推荐上游小扩展；读取现有 Session policy，不引入第二设置来源 | 不把模型 route allowlist 混成 OS/file 权限，也不默认任何已注册模型都已授权 |
| 模型观测修正 | **若要真实逐模型记录，不能保留冷成员 Lead-model fallback 作为事实**。优先读取 native descriptor/请求投影并区分声明/实际；需要时补公共只读投影 | 不要求把所有选型字段重复写进 Team member snapshot；避免两份相互漂移的配置事实 |
| 固定默认 effort / 冷恢复 preset 语义 | 严格重现需要额外明确语义；显式 route/effort 本已有 descriptor，fresh 独立 preset 也已有保存机制 | 不必为了基础可用性立刻扩充 provider.prepare 返回值或支持 fork 任意换 preset |

推荐 seam 是 **Team 创建请求中的逐成员、不可变配置 + 原生共享选择解析**。Ensemble Module 的 Depth 来自一次选择同时得到合法 route、能力校验、可审计配置与原生 durable 成员，而不是把每个 runtime 方法再包装一层。若确实需要 provider 自己动态决定 local route，才考虑更大的上游 seam：在 descriptor 构造前返回经校验的创建配置，并重新定义授权、能力、并发与恢复契约；当前问题不需要先承担这个扩展。

## 9. 后续真正实施前的验收条件（本轮未执行）

1. 锁定运行构建及对应 Interface；不能以“工具 schema 看起来一样”认定内部实现同 commit。
2. 同一 Lead 并发创建 A/B，使用两个已授权 route 或不同合法 effort；核对 native Team 名字与唯一 child id、child descriptor，以及实际 request/header；确认并发不串配置。
3. 未授权路由、不支持 effort、不允许 preset、fork+独立 preset 在创建前给出清楚错误；校验省略 effort 的默认语义和新 route 不继承不兼容 effort。
4. 成员停留/冷却、Lead 换模型、provider 卸载及进程重启后续聊，核对身份和显式选型仍保持；preset 缺失或模型不可用明确失败，不偷偷回退 Lead 模型。
5. 创建前取消、provisioning checkpoint 失败、运行中 interrupt、跟随消息保留、Team teardown 分别按该版本原生契约验收；未日志化消息不承诺重放。
6. 看板/记录能分别显示声明与实际 route/effort，冷成员没有实际调用证据时展示未知；原生任务/Session 是唯一运行事实来源。

最终判断：**应继续研究并设计逐成员配置的 ensemble Consumer；旧 Team 需要小而明确的上游 bridge，当前证据不足以宣称“插件单独注册 provider 就已可用”。** 迁移到新版原生子代理树也可能提供这条能力链，但那是运行平台选择，不能替代用户对当前具名 Team 的问题。

## 固定源码索引

所有 O 链接固定为 `1e477804c638c57118e90f524b96e95a3764d802`；所有 N 链接固定为 `39163dd30f703a79079e2d2446545cff3c453738`。

[O-tool-spawn]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/experimental/tool-agent-team/src/index.ts#L192-L219
[O-tool]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/experimental/tool-agent-team/src/index.ts#L16-L219
[O-lifecycle]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/experimental/agent-team/src/lifecycle.ts#L45-L105
[N-tool-config]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent/src/index.ts#L45-L102
[O-request]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/experimental/agent-team/src/types.ts#L164-L177
[O-spawn]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/experimental/agent-team/src/roster.ts#L228-L372
[O-start-types]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/subagent/subagent/src/types.ts#L117-L225
[O-membership]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/experimental/agent-team/src/roster.ts#L76-L118
[O-membership-test]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/experimental/agent-team/tests/team.spec.ts#L498-L523
[O-fresh]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/subagent/subagent-spawn-in-process/src/index.ts#L22-L59
[O-fork]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/subagent/subagent-fork-in-process/src/index.ts#L28-L83
[O-provider]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/subagent/subagent/src/types.ts#L305-L355
[O-registry]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/subagent/subagent/src/index.ts#L539-L575
[O-activation]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/subagent/subagent/src/index.ts#L250-L284
[O-capabilities]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/subagent/subagent/src/index.ts#L630-L650
[O-manager-create]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/subagent/subagent/src/manager.ts#L379-L471
[O-option-merge]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/subagent/subagent/src/child-agent.ts#L60-L118
[O-child-composition]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/subagent/subagent/src/child-agent.ts#L177-L218
[O-permission]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/subagent/subagent/src/child-agent.ts#L220-L278
[O-model-tool]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/subagent/tool-subagent/src/index.ts#L278-L337
[O-model-policy]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/subagent/tool-subagent/src/index.ts#L401-L445
[O-model-selection]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/subagent/tool-subagent/src/model-selection.ts#L89-L196
[O-tool-imports]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/subagent/tool-subagent/src/index.ts#L19-L40
[O-descriptor]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/subagent/subagent/src/descriptor.ts#L1-L86
[O-roster-view]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/experimental/agent-team/src/roster.ts#L126-L156
[O-reconcile]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/experimental/agent-team/src/roster.ts#L374-L417
[O-team-send]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/experimental/agent-team/src/index.ts#L223-L247
[O-restore]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/subagent/subagent/src/manager.ts#L1325-L1383
[O-route-test]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/subagent/subagent/tests/continuation.spec.ts#L3752-L3789
[O-retired-test]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/subagent/subagent/tests/continuation.spec.ts#L1049-L1077
[O-preset-test]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/subagent/subagent/tests/continuation-presets.spec.ts#L180-L310
[O-interrupt]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/subagent/subagent/src/manager.ts#L178-L227
[O-interrupt-test]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/experimental/agent-team/tests/team.spec.ts#L1047-L1059
[O-disposal]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/subagent/subagent/src/manager.ts#L1093-L1160
[O-service-disposal]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/experimental/agent-team/src/index.ts#L261-L275
[O-signal-test]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/subagent/subagent/tests/continuation.spec.ts#L3472-L3490
[O-unlogged-test]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/subagent/subagent/tests/continuation.spec.ts#L1975-L1991
[O-final-flush]: https://github.com/deepseek-ai/deepseek-harness/blob/1e477804c638c57118e90f524b96e95a3764d802/packages/subagent/subagent/src/manager.ts#L1208-L1217
[N-team]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/team/agent-team/src/index.ts#L34-L160
[N-selection]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent/src/model-selection.ts#L92-L199
[N-llm]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/llm/llm/src/index.ts#L903-L1008
[N-tool-exports]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent/package.json#L16-L39
[N-restore]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/manager.ts#L1215-L1272
[migration]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/docs/upgrade-guide/v0.2.1-rc.2/agent-team-subagents/guide.md#L12-L30
