# 新版 DSH：ensemble 原生执行与方法适配

日期：2026-11-17（Asia/Shanghai）；execution / task-12。只研究、不实现。目标仅为尚未发布的新版 DSH，不再设计旧具名 Team 兼容。

## 1. 基线与裁决

本轮只读 Lead 准备的[源码副本](</home/vcup/projects/vcup-skills/.scratch/extra-src/deepseek-harness>)。直接核验 `HEAD=39163dd30f703a79079e2d2446545cff3c453738`，origin 为官方仓库，副本工作树干净；相对上一轮同一 SHA 的原生执行相关 diff 为空。**源码版本零变化；本轮变化是适配目标收敛，不是发现新的执行能力。** Lead 的拉取记录由其基线文档负责；这里不重复声称已联网核验所有上游分支。以下 DSH 引用全部固定到该 SHA，不证明当前对话所用运行构建已升级。

**建议：已确认要做的 ensemble 插件，第一版不自写执行器或创建工具。** 使用原生 `subagent`、`subagent_fork`、选型发现、Session policy、preset、消息、Team 任务板和恢复；插件交付 DSH 专用方法、必要的原生组合配置以及现有 Markdown 看板。执行适配首先是配置与指引，而不是 `ensemble_spawn`、provider router、第二 roster、调度队列或生命周期状态机。[原生工具][tool]、[原生运行时][runtime]

跨模型、真实 effort、工具组合的需求在新版已有合法路径。剩余工作是明确实际启用条件、用现有机制安装/配置，以及验证这些机制在所交付组合中确实可见且可用。没有证据要求为了这些基础能力新增上游 Team bridge。

## 2. 方法直接映射到哪些工具

| 方法操作 | 新版原生 Interface | 方法仍须承担的判断 |
|---|---|---|
| 独立首轮 | `subagent({description,prompt,name?,cwd?,provider?,model?,reasoning_effort?,agent_preset?})`，可选字段按配置呈现；返回 `{kind:'activation',name}` | fresh 不继承父对话，但不隔离共享文件及已启用的同树任务板；工具默认随 composition，可另选 preset；共同基线须写进 prompt，首轮不要暴露 sibling 结论 |
| 明确继承上下文的检查 | `subagent_fork` 使用 fork backend，参数由该工具实例配置决定 | 只复制截至最后 `turn/end` 的历史，不含当前 in-flight turn；父已见结论时不能把 fork 当独立盲评；不是 Git 分支/工作树 |
| 续聊、纠正、追问 | `send_message({agent:<返回的完整名字>,message})` | running 接下步输入，idle 开新 turn，cold target 原地恢复；续聊不是新增独立样本，消息送达也不是验收成功 |
| 成员发现 | `list_agents({})`，返回根 `lead` 及可达 continuable 后代；深层地址如 `reviewer/checker` | 保存返回名字，不自己推测地址；`inactive` 仅表示无 turn；工具结果没有 model/effort 字段，不能从中证明异构配置 |
| 等待结果 | `wait_agent({timeout_ms?})`，返回 `{timedOut}`；直接 child 自然结束时有通知 | 只等调用者 inbox（包括已 pending 输入），不等待任务状态变更；不忙轮询，不把一次唤醒视为所有贡献完成；间接成员需要显式汇报路径 |
| 共享工作项 | `team_task_create/list/get/update`；`get` 后以最新 `expected_revision` claim/complete；模型结果 owner 字段为 `owner` | `team_task_list` 用 `unowned:true` 筛未分配，不能与 `owner` 同传；write scopes 是告警不是锁；ready/reassign 不启动成员，应另发消息 |
| 取消当前执行 | 若启用，`interrupt_agent({agent})`，调用者须为祖先；local 可续聊，external 不可续聊 | 返回只表示请求已受理；不停止目标的后代、不清任务 owner、不等于退出确认；不能靠关闭 Team 停止工作 |

来源：[创建 schema/返回值][tool-schema]、[fresh][fresh]、[fork][fork]、[消息/取消][control]、[成员发现][list]、[等待][wait]、[任务工具][tasks]。原生名字是 Session 的地址，不是 ensemble attempt id；同一成员可以接续多个贡献，某贡献也可以因失败由新成员接替。方法应保留贡献目的、输入来历、产物、证据与取舍，不复制运行 roster。

方法取向沿用[现行技能](</home/vcup/projects/vcup-skills/skills/ensemble/SKILL.md#L21-L43>)：有用差异可以是模型、prompt/方向、观察方法、证据、真实工具组合或 effort；同模型不自动降级，跨模型也不自动独立。让需要比较的首轮先各自产出，再交流和演化。原生能力不代替对结果的观察验收。

## 3. 必须交付清楚的配置条件

### 3.1 工具呈现与部署默认

- `tool-subagent` 一实例绑定一个 execution backend；可配置 distinct `toolName`、`modelSelection`、`modelDiscovery`、`agentOptions`、`agentPreset/allowedAgentPresets`。`modelSelection:true` 才露出 route/effort 字段；`allowedAgentPresets` 才露出 `agent_preset` enum。Provider capability 不匹配会报错；provider 未注册时对应创建工具不挂载。不要从“包存在”推断实际工具 schema。[配置与挂载][tool]
- 同一 scope 的 `modelDiscovery` 只应由一个工具实例开启；发现不等于开启选择。原生 discovery 依 Session policy 过滤：无参数列允许 provider，给 provider 列模型，再加 model 列 exact-model effort；允许但不在 advertised list 的模型，仍可做 exact-model 查询，不能以空 list 单独判定 route 不存在。[发现][discovery]
- **标准 Web preset 实际只给 spawn 开 `modelSelection:true/modelDiscovery:true`；fork 没开选择；control 配置 `interrupt:false`。** 方法不能默认这些入口具有相同字段，也不能要求模型调用默认没暴露的 interrupt。需要 fork 选型或模型主动停止时，修改已有原生组合配置，不新增同名包装工具。[标准组合][standard]
- Spawn 可独立选 preset；fork 不支持，包括显式选择与父同名 preset。省略 preset 默认共享父当前 composition，配置 `agentPreset` 则成为该工具实例默认。允许列表、preset 是否存在及实际工具组成须由交付组合确定，不能发明未安装的角色 id。[preset 选择][presets]、[child composition][composition]

### 3.2 Session 模型授权与省略语义

| 输入情形 | 本 SHA 的精确含义 |
|---|---|
| `modelSelection` 关闭 | 不呈现模型参数，执行层也拒绝模型显式选择；prompt 中写模型名不能改变 route |
| 三个 route/effort 参数全省略 | 使用受信任工具默认，未配置时继承兼容父选项；父 provider/model/effort 优先取最近 `request/header`，不是只读创建 options |
| 显式 `provider+model`，effort 省略 | 使用该模型默认 effort，即使 route 与父或工具默认相同，也清掉其既有 effort；不能把“显式同 route”当“全省略” |
| 显式 effort | 必须同时提供 provider+model；只给 effort 或只给 route 一半会报错；使用 exact-model 声明的 effort id，不自行规定通用 low/high 列表 |
| Session 没有 model-selection policy | 选择已启用时，显式 route 限当前父 route；仍可在该 route 选择合法 effort，不等于完全无法选型 |
| Session 已有 policy | 显式 route 必须在精确 provider/model 列表中；不自动额外并入父 route |
| 可信部署 `config.agentOptions` | 可指定默认 route/effort，经原生可用性预检；它不是模型输入的 allowlist 分支。插件不能把模型输入塞进可信 defaults 来逃过授权 |

以上由[请求解析/授权/预检][selection]、[工具执行][tool-exec]、[父选项合并][inheritance]决定。模型路由权限不同于文件/工具权限；选 preset 不赋予 delegated child 更大权限。[委派权限][composition]

Host 的原生 `subagent-model-selection-settings` 默认 off、允许列表为空；启用必须提供非空精确列表。它为新根 Session 记录 policy，子会话继承已有 policy；修改全局设置不回溯改写旧 Session，也不覆盖已保存 policy。插件应引导用户使用现有设置，在授权配置后开适用的新根会话；不维护另一份模型授权表。[Host 设置][settings]

授权成功后仍需能力预检：原生工具调用 LLM `resolveCallConfig`，检查 provider、exact model 和 effort，不支持时拒绝而非静默 clamp。这个预检不绑定最终 dispatch；真实调用另由原生 `prepareCall` 绑定 Adapter 并记录实际请求。v1 直接用原生工具即可同时复用这些检查，**无需复制其内部 helper 或直接包 `startActivation`**。[工具执行][tool-exec]、[LLM 解析][llm]

### 3.3 Team enabled、深度和容量

- Team 就是根 Session 任务板，成员来自同一 subagent 树。原生 subagent 可不依赖 Team mode 创建、互发消息或续聊；启用 Team 是选择任务协作，不是创建另一种成员。[Team service][team]
- `defaultEnabled` 默认 false；配置为 true 只在 root startup 且尚无 saved mode 时应用，不覆盖显式 false。现有根可以通过原生 `setEnabled` 入口切换；不是让模型编一个未存在的 enable 工具。任务工具和 Team policy 仅在根 mode enabled 且 live root 可解析时呈现；queued task 操作还检查当时 mode。关闭不删除任务、不停止成员。[Team mode][team]、[条件工具][tasks]、[任务状态检查][task-mode]
- 原生工具深度默认来自 Host `maxDepth=1`，工具可显式配置；服务树容量 `maxActiveSubagents` 默认 8，创建和冷恢复共用，满额拒绝、不入队。注册了工具不代表当前成员尚有委派深度。方法遇到容量不足应等待/复用/减少同时在途贡献，而不是另写 scheduler 或绕深度限制。[运行时设置][runtime-limits]
- `cwd` 只选择已有目录，保留原权限 roots，不复制文件、不产生隔离。竞争写者必须先准备明确独立的 baseline；disjoint scopes 与文件版本守卫不能代替隔离副本。[cwd 语义][runtime-cwd]、[Team policy][team-policy]

## 4. 身份、恢复和实际选型的记录规则

原生 local 子成员创建即进入 parent catalog，有唯一名字、持久 Session 和后续 activation；同一树的 live member 可以给另一成员发消息。只有目标 cold-resume，其直接 creator 可以 offline，但 root 必须 active；external backend 不是可续聊成员。根关闭由 Host drain 全树，普通成员完成或取消不连带关闭后代。[身份/生命周期][runtime]

继续复用原生持久事实，方法记录只附指针：

1. **创建配置**：manager 持久化合并后的 `agentProvider/agentModel/agentReasoningEffort` descriptor；省略值可能仍省略，不是必然已经发出模型请求。Execution provider 的 `spawn/fork` 不是 LLM provider。[创建][manager-create]、[descriptor][descriptor]
2. **实际调用**：以 child 的 `request/header.config` 为实际 route/effort 证据；普通 `list_agents` 不报告它。选型预检返回 void，Adapter 默认 effort 不会因此自动写回 descriptor。看板若只读取 Markdown，应显示“记录的配置/声明”，无证据不标“已实际调用”。[预检][selection]、[LLM 请求解析][llm]
3. **冷恢复**：从 child descriptor 恢复 route/显式 effort，从 saved projection/header 恢复 preset，不重新继承 Lead 当前模型或 composition；不用原创建 provider 再次 prepare。Preset id 使用当前注册 definition，不保存跨重启的旧 revision；缺失/broken 明确失败。无 saved preset 的历史目标用 Host composition。[恢复][restore]、[恢复说明][runtime-restore]
4. **不是完全重放**：未固定的 Adapter 默认可变化；descriptor 不保存 `maxTokens/outputSchema` 这类 activation 预算。消息接受与日志落盘不是 exactly-once；离线 creator 不自动恢复来接收完成通知。重要结果仍需持久产物与显式汇报。[descriptor][descriptor]、[通知/限制][runtime-notice]

因此不增加 ensemble session store、成员镜像、默认模型回填或冷恢复队列。需要恢复的是原生成员；需要方法层重新判断的是尚缺贡献、失效证据以及下一步工作。

## 5. 插件 v1 的可执行范围

| 要交付 | 复用或新增 |
|---|---|
| DSH 专用方法与任务 prompt 指引 | 新增方法内容：依据 native name、fresh/fork、两种 effort 省略、独立首轮/复用、证据验收写清流程；删除 OMP 专有或旧 Team 路径 |
| 能力组合与启用说明 | 默认复用 standard 已启用的 spawn 选型，不默认 patch/替换 delegation 组；只有明确需要时才调整已有 fork/control/preset 配置。使用原生 Team/selection settings，不默认授权任意模型；对最小支持组合做 Loader 级集成验收 |
| 现有 Markdown 专用看板 | 确认要做；读取方法已有记录，呈现贡献/差异/证据/决策及缺口，不把文件解析成调度命令；详细 Client Module 设计由看板研究负责 |
| 新的 spawn/select/stop tool、provider router、roster、恢复数据库 | **v1 不写**；原生已有对应行为，新增会复制授权、并发和生命周期知识 |
| 额外选型诊断或复用模板 | 只有后续真实重复需求才单独立项；优先现有发现工具与设置，不预造 profile DSL 或共享 mutable “当前模型”槽位 |

此切分不是取消已确认的插件，而是将其 Depth 放在 ensemble 方法和可读决策视图上，避免重写 DSH 已有的执行 Module。

**包内参考资料的窄例外：** Host 顶层 skill provider 和只读参考工具可经全局 registry 层供 standard 使用，不必为了可见性修改 preset；自定义 scoped allowlist 或同名 shadow 仍可隐藏它们，需在目标组合验收。[技能层合并][skill-layers]、[工具层合并][tool-layers]。原生 `skill` 仅按 name 取整份 skill，`resourceBase` 只是提示，不把 Host 包路径映射到 container。因此若核心/模板直接随 `/ensemble` 加载，而其余参考资料要按需读，固定 document enum 的 `ensemble_reference` 是可成立的小 Interface；它不是执行工具。不接受任意 Host path，不另建 MCP server，不把参考文档冒充若干独立技能；也不承诺所有自定义 preset 都可见。[原生 skill loader][skill-tool]、[资源提示][skill-resource]

## 6. 实施阶段的具体验收（本轮均未执行）

1. **真实组合与呈现**：通过目标 DSH Loader 加载交付组合；核对 spawn 的 name/route/effort 字段、preset enum、fork 是否按设计开放选型；同 scope discovery 不重复。Team off/on 后下一步工具/policy 正确改变；subagent 不随 Team off 被杀；interrupt 的默认关闭/显式启用一致。
2. **授权与省略矩阵**：新根授权 A/B 后并发选两个 route；无 policy 时显式不同 route 拒绝、父 route 的合法 effort 可选；已有 policy 不自动包含父 route。验证全省略继承、显式同 route 未给 effort 取默认、effort-only 拒绝、不支持 effort 拒绝；无效请求不返回成功成员，失败 startup 释放原生 reservation/容量；不要把这项验收扩写为所有失败都绝无诊断 Session 残留。修改 Host 设置不改旧 Session。
3. **preset 与上下文**：fresh 选允许 preset 取得实际目标工具；不在列表/不存在 preset 明确失败；fork+独立 preset 拒绝。证明 fork 无当前 in-flight turn，fresh 无父对话；同时承认共享文件可泄露 sibling 结论，不把上下文测试当认知隔离证明。
4. **身份和任务**：同 creator 并发重名正确拒绝；使用返回完整名字消息/assign；任务 owner 输出与 `unowned` 筛选吻合，旧 revision 失败、DAG/write-scope 告警正确；任务提交不唤醒成员，随后 send 才推进工作。
5. **生命周期**：成员完成后 send 续聊、冷恢复 route/显式 effort 保持；Lead 改模型、原 provider 卸载、preset 更新/缺失分别验证既定行为。直接 creator offline 但 root online 可恢复目标；root 不在线明确不可用。模型不可用不静默换 Lead 模型。
6. **取消/等待/容量**：创建前取消与接收后取消分开；interrupt 保留 accepted inbox、不递归停止后代；确认停止前不重新派竞争写者。wait 对消息/通知唤醒，对 task-only 变化不唤醒；深度/满额拒绝可理解，cold resume 也受容量约束。
7. **最终证据**：对照实际 request/header 核对 route/effort，不以名字、prompt 或 descriptor 缺省猜测实际调用；看板无法读取 live 事实时明示快照。成员结束、task complete 与交付验收分开；共享 baseline 竞争写必须有独立目录和最终 diff/测试证据。

实施验收应包括真实组合的 keyless model-visible snapshot、权限与生命周期集成测试，以及配置好的真实 Adapter smoke；不要将本文的静态阅读报告当成这些验收已通过。

## 固定来源

[skill-layers]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/skill/skill/src/index.ts#L554-L567
[tool-layers]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/core/tools/src/index.ts#L191-L226
[skill-tool]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/skill/tool-skill/src/index.ts#L85-L160
[skill-resource]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/skill/skill/src/index.ts#L173-L210
[tool]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent/src/index.ts#L45-L397
[tool-schema]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent/src/index.ts#L219-L273
[tool-exec]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent/src/index.ts#L275-L338
[standard]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/bundle/web-app/presets/standard.patch.yml#L89-L116
[fresh]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent-spawn-in-process/src/index.ts#L32-L59
[fork]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent-fork-in-process/src/index.ts#L38-L83
[control]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent-control/src/index.ts#L39-L157
[list]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent-control/src/list-agents.ts#L12-L95
[wait]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent-control/src/wait-agent.ts#L20-L115
[tasks]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/team/tool-agent-team/src/index.ts#L80-L234
[task-mode]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/team/agent-team/src/task-board.ts#L24-L54
[team]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/team/agent-team/src/index.ts#L45-L160
[team-policy]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/team/tool-agent-team/src/index.ts#L26-L33
[discovery]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent/src/list-models.ts#L39-L135
[presets]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent/src/preset-selection.ts#L5-L75
[composition]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/child-agent.ts#L135-L283
[selection]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent/src/model-selection.ts#L92-L199
[inheritance]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/child-agent.ts#L60-L118
[settings]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent/src/model-selection-settings.ts#L25-L89
[llm]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/llm/llm/src/index.ts#L903-L1008
[runtime]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/README.md#L59-L82
[runtime-limits]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/README.md#L47-L57
[runtime-cwd]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/README.md#L26-L28
[runtime-restore]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/README.md#L135-L147
[runtime-notice]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/README.md#L173-L241
[manager-create]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/manager.ts#L324-L402
[descriptor]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/descriptor.ts#L1-L85
[restore]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/manager.ts#L1215-L1272
