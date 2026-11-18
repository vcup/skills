# DSH 原生协作与异构模型：本轮补充证据

范围：设计研究，不是实现或兼容性测试。DSH checkout 固定为 `39163dd30f703a79079e2d2446545cff3c453738`；工作区基线为 `689972f5911aaa0d14f11edaca0990a13443e5c9`。本轮实际工具结果与源码能力分别列出。

## 1. 当前会话实际验证了什么

本轮通过真实 `spawn_teammate` 创建 `methodology`、`dashboard` 两名 fresh 成员；分别领取共享 task-1、task-2；Lead 领取 task-3。任务带互不重叠的文档写入范围；成员通过 `team_task_get/update` 的 revision 领取任务并用 `send_message(target)` 报告结果。

工具返回两名成员的模型均为 `gpt-6-astra`。本轮是同模型、不同研究问题的并行协作，不能用来证明跨模型运行成功或模型多样性的收益。

当前 `spawn_teammate` schema 只有 `name/description/prompt/context`；`context` 可为 `fresh/fork`，没有逐成员 provider/model 选择参数。当前工具发现没有找到 `list_subagent_models`。这只能说明本会话工具面未提供该操作，不能推断整个 DSH 没有模型选择能力。不能往 prompt 写一个模型名就声称切换了模型。

## 2. 当前工具与 checkout 是两套接口基线

| 方面 | 本轮实际具名 Team 接口 | checkout 的原生协作接口 |
|---|---|---|
| 创建 | `spawn_teammate`，fresh/fork | `subagent` / `subagent_fork` |
| 成员地址 | `target`，具名成员 | `agent`，catalog full name；服务层解析为 Session id |
| 创建权限 | Lead-only | 普通子代理树与原生深度/容量约束 |
| Team 所有权 | 结果含 `ownerName`；重派参数 `owner` 接受成员 target | 工具接受 owner name；持久事实仍有 `ownerId`，附保存的 `ownerName` |
| 等待 | Team 状态/消息/任务变化；无其他 running/provisioning 成员时 noProgress | caller inbox；任务提交不唤醒、不开始 agent |
| 生命周期 | 具名 durable 成员，send 可开始或继续 turn | 本地 spawn/fork 为 continuable，可用消息续聊；其他 provider 以其 continuation 能力为准 |

DSH [早期升级指南](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/docs/upgrade-guide/v0.2.1-rc.2/agent-team-subagents/guide.md#L12-L30) 记录移除 `spawn_teammate`、`target`、Team 私有 roster/控制接口，转为普通 subagent 树。其 `agent_id` 寻址说明又被后来的 [catalog names 决策](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/.agents/notes/implemented/architecture/2026-11-02-subagent-catalog-names.md#L13-L39) 覆盖：当前 [消息工具实现](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent-control/src/index.ts#L43-L81) 是 `send_message({agent, message})`，先按名字解析，再以 Session id 调服务；[Team 工具](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/team/tool-agent-team/src/index.ts#L143-L179) 同样支持 owner name。不能把历史迁移文档当作当前 schema。故“Team 就是 subagent 树”适用于该 checkout，不宜直接描述本轮已开放的具名 Team 工具。运行安装目录在本容器不可见，精确运行版本仍未确认。

[架构决策](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/.agents/notes/implemented/architecture/2026-10-15-agent-teams-as-subagents.md#L9-L23) 说明收敛原因：旧 Team 已在复用 subagent 的持久 Session、恢复和 activation；另维护 roster、寻址和消息会重复身份与生命周期。Ensemble 应沿用这一收敛方向，避免再增加自己的成员运行时。

## 3. 异构模型需要满足的原生条件

源码中的模型选择链是：可用 LLM adapter → 原生模型目录 → 新根 Session 记录允许路由 → 子代理工具发现与选择 → 路由预检 → 原生 activation。

- [standard preset](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/bundle/web-app/presets/standard.patch.yml#L99-L110) 对 spawn 开放 `modelSelection: true`、`modelDiscovery: true`；这不等于用户已授权任意模型。
- [设置服务](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent/src/model-selection-settings.ts#L25-L89) 默认关闭；启用时必须列出精确 provider/model 路由，主要作用于新建根 Session，子 Session 继承已有授权。
- [Session policy](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent/src/model-selection-state.ts#L9-L47) 记录第一次策略；缺失时显式选择仅限当前父模型路由。修改全局设置不能假设回溯更新既有 Session。
- [模型发现](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent/src/list-models.ts#L39-L97) 仅返回 Session 允许的路由；发现能力不足时可说明原因，不应另起请求旁路绕过授权。
- [工具执行](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent/src/index.ts#L282-L337) 在显式选型或配置 LLM 选项时执行路由预检，再调用 `ctx.subagents.startActivation`；普通默认继承路径不必经过同一预检分支。Ensemble 无需自己构造 LLM loop。
- [原生 Web 设置](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/client/ui-settings-subagent/README.md#L25-L42) 已有启用开关和具体允许模型列表。专用看板可以给出这一配置方向，不必再制作第二套模型配置。

结论：HEAD 源码具备真正异构模型的执行链；本会话的具名 Team schema 没有对应选择字段。接续研究定位到与之匹配的旧实现 `1e477804c638c57118e90f524b96e95a3764d802`：不仅工具缺字段，Team 请求和 roster 转交也缺少子模型配置；直接绕过 roster 创建子代理又不成为旧 Team 成员。故应区分“新版本配置原生选型”和“旧 Team 最小原生扩展 + 插件适配”，不能只建议等待可选模型版本。依据与限定见 [旧 Team 接入研究](TEAM-MODEL-SEAM-RESEARCH.md)及[执行选择设计](EXECUTION-ADAPTER-DESIGN.md)。安装 ensemble 插件本身不赋予模型授权，也不自动改变用户模型设置。

## 4. 必须把模型、上下文、成员身份分开

[子代理配置合并](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/child-agent.ts#L60-L118) 默认从父代理的最新请求配置继承 provider/model。**fresh 是对话起点选择，不是模型选择**；创建两个 fresh 成员仍可能全是同一模型。

[持久 descriptor](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/descriptor.ts#L50-L85) 分开保存 continuable 模式与声明模型配置。**可续聊不表示已形成独立的新尝试**；恢复也不应默认为继承 Lead 现在的模型。新任务号、新名字、换模型但继承原论证，都不足以单独证明认知独立。

设计建议：按问题选择模型、提示/方向、方法、工具和推理配置的实质差异；同模型组合可以是有效 ensemble，不一概称为降级。关键判断若担心共同模型因素，应优先考虑可用、获准且适任的另一模型；如果计划明确要求跨模型而当前接口无法表达，就记录这一具体缺口。通过新上下文或已知未接触结论的上下文降低锚定。任务不同本身也可能只是分工，是否构成 ensemble 要看其贡献能否补足遗漏、挑战假设或改变最终候选。详见 [多维异构复核](HETEROGENEITY-RESEARCH.md)。

`reasoning_effort` 与“深入思考”的指令需分开。HEAD 工具显式 effort 请求必须同时给出 provider/model；显式选路但省略 effort 时取路由默认值。创建 descriptor、后续 Session 模型选择、一次请求的解析配置是不同证据层；核实实际采用值时以相应原生请求记录为准，不能由角色名或输出长短推断。

模型路由可观察不等于已知底层模型相互独立；多个别名/服务商可能转发到同一模型。第一版保留可观察的模型说明，不计算“独立概率”或虚构多样性分数。

## 5. 插件边界的推论

- 方法层决定哪些差异和重复观察值得投入、何时独立生产、怎样用证据改进交付。
- 执行选择适配将模型、真实 effort 和必要 preset 落到原生能力；新版本优先组合原生工具，旧 Team 必要时补齐原生请求与转交。插件不能把模型提交的任意路由伪装成部署默认值以绕过授权。
- 原生执行层保持 Session、成员身份、消息、恢复、任务与实际权限。底层 activation 不自动执行选型工具中的路由授权；定制入口需要共用该选择逻辑。
- 文件保存当前交付判断及证据指针；运行日志与原生任务仍保存执行事实。
- Client 看板把这些已有 Markdown 记录组织为可读视图。它可以有自己的瞬时解析模型与缓存，无需新持久化格式、Team 镜像或隐藏状态数据库。

本轮未更改任何路由、preset、插件、产品代码或现行方法文档。模型选择与插件运行验收均留待实现阶段。
