# 原生 subagent 的通信、共享任务与作用域核验

> **历史能力研究：`39163dd` 开发快照。** 原研究日期为 2026-11-18 UTC，目标源码固定为 `deepseek-ai/deepseek-harness@39163dd30f703a79079e2d2446545cff3c453738`。它不是正式 rc.3 或 rc.4 发布提交。现行基线是正式 rc.4 `3f321d32bfe382212a8ed8785c1d47a5a300aa23`，以[原生代理接入](<../NATIVE-AGENTS.md>)为准；两者关系与发行差异见[发布基线](<RC4-BASELINE.md>)和[代理复核](<RC4-AGENTS.md>)。

原研究只读检查固定源码，未执行 Git、安装、构建或测试；测试文件仅作为源码证据阅读。下文“目标 SHA”均指开发快照，不把源码支持当成任意部署已启用。会话地址、工具数量和本机探查流水不随报告迁移，仅保留可复用的证据边界与验收条件。

## 结论

**目标 SHA 已经支持用普通原生 subagent 协作，无需另造特殊 teammate 身份、创建器、消息层或成员注册表。** 本地进程内 `subagent`（fresh）和 `subagent_fork` 都创建可续聊子代理；同一棵树内 root、child、sibling、其他分支的 continuable descendant 可通过原生 `send_message` 通信。原生 `list_agents` 从调用者所属 root 开始列整个可达树，而不是仅列调用者自己的孩子。消息能力本身不要求 Team 开启。[S1][][S2][][S3][][S4][]

**共享任务是可选 Team task board，成员仍是普通 subagent。** 加载 Team 服务及工具并在 root 开启 Team 模式后，fresh 与 fork 子代理都读取 root 的同一任务板，可自行领取 ready task；领取是 `team_task_update(action: "claim")`，不是独立 `team_task_claim`。只依赖通用代理的设计可以复用该任务板，但不能把“源码存在”写成“当前会话已启用”。[S5][][S6][][S7][][S8][]

**源码能力、部署工具表面和运行成功是不同证据。** 部署可能只暴露 `send_message({agent_id,...})` 与 children/descendants 范围的 `list_agents`，也可能没有 Team 工具；不能把这种表面与固定 SHA 的 name-based whole-tree 工具混用。某会话能向 parent 发送消息，不证明 sibling 可达或共享任务可领取；某部署没有这些入口，也不能反向否定目标源码能力。

## 1. 证据层次与验证边界

| 层次 | 原研究证据或需核对的对象 | 能支持的结论 | 不能支持的结论 |
|---|---|---|---|
| 固定源码实现 | 直接阅读 provider、manager、工具执行器、Team service/task board/preset 代码 | 指定 SHA 的路由、授权、条件与默认值 | 某部署或 GUI 已加载这份源码 |
| 固定源码中的组合 | 阅读 base 和 Web standard preset 的 YAML | 这些组合明确加载的插件、选项 | 开发快照就是正式发行，或任意 profile、自定义 patch 都相同 |
| 已有测试源码 | 阅读 sibling/cross-tree、fresh/fork 共享模式等测试 | 上游有相应可执行断言；辅助理解 | 原研究已重新运行测试通过 |
| 部署工具发现 | 核对完整工具目录与实际 schema，不能只看搜索召回 | 某会话实际可发现的工具名与参数 | 缺失原因必然是源码不支持；旧构建、未加载、scope 过滤、mode 未开须另查 |
| 部署实际调用 | 分别观察 list、message+ack、共享 task 读写 | 具体调用及已收到的对方回应 | delivery confirmation 等于处理完成，或 child→parent 成功等于 sibling/cross-branch 成功 |
| 未执行的行为验收 | 原研究未建立同级往返、共享任务 claim/完成、冷恢复的完整运行证据 | 明确保留验证缺口 | 目标源码在某部署已经通过这些验收 |

固定 SHA 的 [list-agents 原始文件](<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent-control/src/list-agents.ts>)与下文 GitHub 定位保留为来源；原研究主要依据直接阅读的实现，不声称重新验证整个 checkout 的 Git 状态。

验证时还须保留这些限制：身份从原生创建返回、消息来源或授权的列表取得，不从临时路径猜测；工具可见不等于仍有委派深度或操作权限；通信按实际 schema 和授权关系执行，不绕过工具边界。共享任务探针只使用明确分配的独立测试对象，不把既有任务或旧成员当作实验对象。

## 2. Fresh、fork、resume 是三种不同操作

| 操作 | 对话历史 | 工具 / persona 组合 | 同树协作与身份 |
|---|---|---|---|
| 进程内 fresh spawn | provider 不提供 seed；不继承 parent 对话 | 无独立 preset 选择时加入 parent 当前 preset revision；有显式选择则加载所选 preset | 新 Session、保存 direct creator 和深度，成为现有树的 continuable member |
| 进程内 subagent fork | 仅复制到最后一个 `turn/end` 的完整前缀；不含当前未完成 turn；没有已完成 turn 时无 seed | 默认继承 parent preset；provider 不支持独立 preset 选择 | 同样是 continuable member；不是新 root |
| 消息触发 cold resume | 恢复目标自己的持久 Session，不重新截取 parent 最新历史 | 从目标自己的 projected preset / header 恢复；兼容历史 descriptor 的 persona/toolFilter；不重新捕获 parent 当前权限 | 保持目标 Session 身份，仅恢复目标，验证其创建链仍属于当前 live root |
| 普通 Session fork | 可有历史 seed，但不是 `subagent_fork` 创建边 | 独立会话的组合规则 | 是新的 root/tree；不能仅凭历史 parent 字段共享原树权限与任务板 |

直接实现：[S9][][S10][][S11][][S12][][S13][]。区别尤其重要：**fresh 的“零 parent conversation”不意味着零工具、零服务或脱离协作树；fork 的“继承对话”也不意味着复制所有权限和运行时配置。** 工具描述生成函数专门把 conversation inheritance 与 tool/service/scope/authority inheritance 分开说明。[S14][]

两种本地 provider 都实现 `prepareContinuable`，manager 写入 `mode: 'continuable'`，因此不能沿用旧版“fork 是 one-shot”的判断。外部 ACP、Codex、Claude Code、DSH SDK backend 的委派不接受上述 follow-up；普通原生协作设计应明确要求进程内可续聊 backend，而不是根据工具名称一概认定。[S9][][S10][][S11][][S14][]

resume 还要求持久化、Session query、可读且支持的 descriptor、有效创建 catalog 链以及 live root；cap 满或 teardown 等也可能拒绝。手工独立 resume 一个原 subagent，而没有对应 runtime owner，不会使它自动成为新协作 root；`rootOf` 抛 `UNAUTHORIZED`，Team 工具条件返回 false。[S2][][S3][][S6][]

## 3. 消息、发现与身份的真实权限

| 关系 / 操作 | 固定 SHA 行为 | 核心约束 |
|---|---|---|
| root → direct child / 任意深度 descendant | 允许 | 目标必须属于同树、支持本地续聊 |
| child → parent / root | 允许 | sender 是 exact live Agent 且仍由该 root 管理 |
| sibling → sibling | 允许 | 不需要 Team mode；可恢复已冷却目标 |
| 同树不同分支（如 cousin） | 允许 | 根据创建链 / runtime ownership 验证，不局限直接关系 |
| 任意 agent → 自己 | 拒绝 | `UNAUTHORIZED` |
| 任意 agent → 其他 root 的 member | 拒绝 | live activation root 比较或持久化创建链验证 |
| 没有 active runtime owner 的原 subagent | 不能使用树权限 | 不把 orphan 当作新 root |
| interrupt sibling / parent | 不允许 | `interrupt_agent` 为 ancestor→descendant 权限，与 message 不同 |

运行时而非工具描述执行授权：`rootOf` 检查 exact live caller；`sendMessage` 禁止 self；live target 比较 activation.root；cold target 回溯 header、own descriptor 和 creator catalog；消息真正入 inbox 前再次检查 sender。不同 root、失效对象、伪造或缺失创建边不能通过猜 Session id 绕过。[S2][][S3][][S4][]

**name 是树内地址，Session id 是底层持久身份。** root 名称固定 `lead`；后代使用从 root 开始的路径，例如 `reviewer/checker`。创建时可提供短 name，同一 creator 下唯一；未命名旧历史可回退 Session id。`resolveName` 只做解析，不授予权限：单 token 未匹配可以作为 Session id 继续进入真实授权；未匹配的 slash path 直接失败。目标 SHA 的模型工具参数为 `{agent: "<name>", message: "..."}`，不能与其它部署的 `{agent_id: ...}` schema 混用。[S1][][S2][][S11][][S14][]

**`list_agents({})` 对任一有效 member 都返回 root + 所有 reachable continuable descendants，包含 caller 自己、siblings 和其他分支。** 它从 root 的持久 catalogs 遍历，不唤醒 agent；外部/one-shot rows 不作为可续聊对象展示，但遍历可穿过 one-shot 节点寻找后代。损坏、unsupported、unavailable 分支有诊断，不能等同“整棵树都正常可唤醒”。`inactive` 仅表示无 turn 执行，不表示任务已完成或工作成功。[S1][][S2][]

消息返回 delivery confirmation / inbox id，不是目标答案。运行中的 target 在后续 step 收到 steer，idle target 启动 turn；cold target 在 live root 下恢复，**无需让中间 creator 复活**。源测试直接覆盖 sibling cold resume、跨分支、回 root、跨 root 拒绝，以及仅恢复 leaf、不恢复 creator。[S3][][S4][][S15][]

## 4. Team root mode 与共享任务

Team 本身没有另一套 teammate 执行身份。`agentTeams.isEnabled/getTask/listTasks/createTask/updateTask` 均由 `subagents.rootOf(caller)` 选择同一个 root。历史 roster 不授予 membership 或 assignment 权限。服务配置的 `maxMembers/maxMessageBytes/disposalTimeoutMs` 和 Team 工具配置的 `freshProvider/forkProvider/interrupt` 已被移除且明确拒绝。[S5][][S6][][S7][]

| 条件 / 开关 | 插件自身默认 | 固定开发快照的组合 / 生效范围 |
|---|---|---|
| Team 服务与工具安装 | 必须实际组成服务、工具及依赖 | base YAML 加载 `agent-team` 和 `tool-agent-team` |
| root 的 Team mode | `defaultEnabled: false` | base 不覆盖；root 会话菜单选择后树共享；子代理不可 `setEnabled` |
| `defaultEnabled: true` | 可选 deployment 配置 | 仅新 root startup、无已存 selection 时写 mode；不重置 resumed Session；ordinary fork 是独立 root |
| Team 关闭 | 下个 step 条件隐藏工具与 guidance | 不删 task，不停子代理；service task access 也检查 `TEAM_DISABLED` |
| task 上限 | 非 deleted 任务最多 256 | `maxTasks` 可配置 |
| delegation 深度 / 容量 | maxDepth 1；maxActiveSubagents 8 | 可由 host / tool 配置调整；不是 Team 专属限制 |
| interrupt | control 插件自身 true | base 与 Web standard preset 显式 false；与 Team mode 无关 |

来源：[S5][][S6][][S16][][S17][][S18][]。已有保存的 mode 优先；历史 task board 没有 mode record 时，projection 为兼容历史把它视为 enabled，因此“新 root 默认关闭”不等于“所有历史 session 都关闭”。ordinary Session fork 排除继承 mode，task 由 root/team id 隔离；真正的 subagent fork 则通过 runtime root 读取现有板。[S5][][S19][]

源码测试对 `spawn` 和 `fork` 两种真实子代理均断言：child list 得到 root 的同一 task，child 不另存 mode；root 关闭后当前 child 和后来 child 都读到关闭。这里只阅读测试，没有执行。[S8][]

## 5. Task list/get/claim/update 规则

所有 task id 都是 root-local，工具没有跨 root 的 board id 参数。下面以 mode 开启、工具实际可见、caller exact live 且 root 有效为前提。[S5][][S6][][S7][]

| 操作 | 谁可用 | 附加条件 / 结果 |
|---|---|---|
| create | 任一 member，包括 root | 新任务 pending、无 owner、revision=1；检查数量、字段、依赖图 |
| list | 任一 member | 默认所有非 deleted 任务；工具支持 status/owner/unowned/ready 与 cursor/limit；不是“只能看自己的任务” |
| get | 任一 member | 返回最新完整任务，含 deleted tombstone |
| claim | 任一 member为自己领取 | current revision 匹配；pending；没有其他 owner；所有 blockers completed；变 in_progress 并记录 caller id/name |
| release | owner 或 root | 仅 in_progress；回 pending，清 owner |
| edit | owner 或 root | 至少 subject/description/write_scopes 之一 |
| set_dependencies | owner 或 root | 完整 blocker list；检查存在、非 deleted、非重复、无自依赖或环 |
| complete | owner 或 root | 仅 in_progress→completed；owner 保留 |
| reopen | owner 或 root | 仅 completed→pending；清 owner |
| reassign | **仅 root** | pending/in_progress；指定 owner 时需 ready，目标是 root 或可达 continuable descendant；省略 owner 则清空并回 pending |
| delete | owner 或 root | 不能有任何未删除任务依赖它；保留 tombstone |

全部 update 都要求 `expected_revision`；先拒绝 stale revision 和 deleted，再进行各 action 的权限与状态检查，成功 revision 加 1。root 本身也不能通过 claim 抢走别人占有的任务，需使用 root-only reassign。非 owner 普通 member 也不能 edit 一个未认领任务（owner 不存在，只有 root 满足授权）。[S7][]

领取流程为：`team_task_list` → `team_task_get`（拿最新 revision）→ `team_task_update({task_id,expected_revision,action:"claim"})` → 做任务 → 用最新 revision complete。不存在独立 claim 工具。多 member 并发 CAS 由同 root journal queue 串行化，不能用过期 revision 覆盖其他人的变更。写入 root Session 后 flush 失败会报 `TEAM_TASK_PERSISTENCE_UNCONFIRMED`，任务可能已可见；应先 get 确认，不能当作未写入盲重试。[S6][][S7][][S20][]

`writeScopes` 是重叠警告，不是文件锁、sandbox grant 或互斥队列；不阻止 claim。`ready` 仅指 pending 且 blockers 全部完成。任务更新、依赖解除、reassign 或 Team mode 变化均不自动发 inbox、唤醒 owner、结束 `wait_agent`；需要显式 `send_message`。inactive、interrupt、进程退出或失败不自动 release owner。[S6][][S7][][S21][][S22][]

## 6. 工具配置如何继承

1. **历史继承与工具继承分开。** fresh 与 fork 都通过同一 `applyChildComposition` 组合运行环境；是否复制 parent completed turns 是 provider 的另一项选择。[S9][][S10][][S12][]
2. **默认继承的是 parent 当前 preset revision。** 未选独立 preset 时，`composeFrom(childCtx,parent.ctx)` 加入 parent 已保留的 exact revision；不是把 parent 上次工具 schema 复制进 prompt，也不是重新选择一个同名最新版本。无 preset 服务/未组成 preset 时使用 host composition。不能将这概括成“parent 任意 agent-local override 全量自动克隆”。[S12][][S23][]
3. **fresh 可显式选择 preset。** `agentPreset` 是 deployment 默认；只有 `allowedAgentPresets` 才让模型获得 `agent_preset` enum。显式同名 preset 也加载当前可用 revision。fork 与外部 provider 不支持独立 preset 选择，执行/加载有检查。[S9][][S10][][S14][][S24][]
4. **工具集合属于 preset/plugin composition。** 此 SHA 的 `tool-subagent` 不再接受 `persona` 或 `toolFilter` 配置，会拒绝并要求迁移到 preset。历史 Session descriptor 的 persona/toolFilter 仅在 cold resume 兼容恢复。[S12][][S13][][S14][]
5. **restore 使用 child 自己的记录。** projected preset 优先于 creation header，没有 preset 的历史 child 使用 host；加载当前可用 preset revision，不保证历史插件字节冻结。不从 parent 当下工具集合重建。[S12][][S13][][S23][]
6. **实际可用工具仍取决于 scope、restrict、shadowing、条件与 step admission。** 工具 registry 会求这些交集；Team 工具 `when` 查询 live root mode，service task board 又做 mode 检查。一个源码 export、一个注册工具或 parent 看得到某工具，都不足以宣称任意 child 当前可调用。[S6][][S25][]
7. **权限不是靠 persona 文本继承。** delegation 捕获 parent 显式 sandbox override 与 Auto/Full access preset，并把有审批服务的 child policy 固定为 `never`；fork 的新 delegation policy 放在继承前缀之后；cold resume 重放自身已有 policy，不重新捕获 parent 新授权。实际文件或命令权限另受相关服务执法。[S12][][S13][]

相关另一个容易混淆的开关：`modelSelection` 与 `modelDiscovery` 插件默认均 false，Web standard 的 spawn 显式 true、fork 未开启。它们是 LLM route 选择，并不决定 sibling messaging 或 Team membership；不要为复用原生代理添加一个专用 teammate 选型层。[S14][][S17][]

## 7. 对设计的直接建议与待验收项

建议以 **普通 subagent tree + 原生 list/message + 可选原生 Team task board** 为基础。角色、任务材料、产出格式由 prompt/skill/preset 表达；fresh 用于独立上下文工作，fork 仅用于确实需要完成历史的工作。无需添加新的 member id、roster、teammate lifecycle 或消息转发器。

执行策略应区分两种已知能力：

- 原生控制可用、Team 未开启：root 直接委派、发消息、聚合结果；不要声称存在共享 claim。
- Team 工具实际可用：成员 list/get/CAS claim，root-only reassign；任务事件不唤醒成员，显式 message 协调；写范围只是建议，仍需调度避免冲突。

部署验收应使用专用 probe 对象：确认调用者和另一个 fresh sibling 的原生 id/name；双方各一次带 nonce 的 message+ack；只对新建测试 task 执行 list/get/claim/complete（遵守实际 schema 与 revision）；每一步记录工具结果与对方收到的证据。没有这些对象或 Team 工具不可用时，保留“互通信/claim 未验证”。部署不支持时记录运行时差异，不绕过权限或污染旧任务。

## 固定 GitHub 实现来源

所有来源均固定同一个 SHA；行号定位的是原研究直接阅读的实现或测试。

- [S1 — control 工具、身份注入、send_message schema](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent-control/src/index.ts#L39-L157)；[whole-tree list_agents](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent-control/src/list-agents.ts#L21-L96)。
- [S2 — root/names/name 解析、消息与发现服务](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/index.ts#L294-L429)。
- [S3 — exact-live root、sendMessage、创建链授权](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/manager.ts#L503-L619)。
- [S4 — inbox 路由、不同 root 拒绝、cold restore](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/manager.ts#L1167-L1323)；[ancestor interrupt](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/manager.ts#L189-L233)。
- [S5 — Team defaults、root mode、各服务调用的 root 选择](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/team/agent-team/src/index.ts#L32-L161)。
- [S6 — Team 条件工具、list/get/update schema、无自动唤醒指导](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/team/tool-agent-team/src/index.ts#L23-L234)。
- [S7 — task board 的实际 mode/CAS/ownership/state-transition 校验](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/team/agent-team/src/task-board.ts#L42-L259)。
- [S8 — spawn/fork 共用 root mode/board 的测试源码](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/team/agent-team/tests/team.spec.ts#L107-L194)。
- [S9 — fresh provider](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent-spawn-in-process/src/index.ts#L32-L54)。
- [S10 — fork seed 与 capabilities](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent-fork-in-process/src/index.ts#L38-L78)。
- [S11 — local creation、continuable descriptor、creator catalog](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/manager.ts#L300-L420)。
- [S12 — child composition、depth、preset、delegated policy](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/child-agent.ts#L39-L282)。
- [S13 — create 与 resume 分支](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/manager.ts#L823-L867)；[resume 自身 preset/descriptor](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/manager.ts#L1215-L1272)。
- [S14 — delegation 工具 config、能力检查与参数](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent/src/index.ts#L45-L260)；[外部 backend 限制](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent/README.md#L58-L79)。
- [S15 — sibling、cross-root、跨分支与 target-only restore 测试源码](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/tests/sibling-messages.spec.ts#L131-L273)。
- [S16 — base 实际插件组合与 interrupt:false](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/bundle/base/cordis.patch.yml#L363-L405)。
- [S17 — Web standard preset delegation 组合](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/bundle/web-app/presets/standard.patch.yml#L89-L116)。
- [S18 — subagent depth/capacity 默认值](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/index.ts#L185-L198)。
- [S19 — Team projection：inherited mode 过滤、teamId 过滤、历史 task 的默认 enabled](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/team/agent-team/src/projection.ts#L104-L150)。
- [S20 — root 事务串行化、append/flush 失败语义](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/team/agent-team/src/journal.ts#L39-L74)。
- [S21 — readiness 与 write-scope warning](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/team/agent-team/src/task-view.ts#L16-L55)。
- [S22 — Team 限制、无自动 ownership release](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/team/agent-team/README.md#L188-L203)。
- [S23 — preset mount/current revision 与 composeFrom/exact parent revision](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/preset/agent-preset-registry/src/index.ts#L265-L332)。
- [S24 — independent preset 的 allowlist 与 provider 拒绝](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent/src/preset-selection.ts#L18-L75)。
- [S25 — tools 的 scoped restrictions](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/core/tools/src/index.ts#L155-L194)；[条件与 step admission](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/core/tools/src/index.ts#L243-L296)。

[S1]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent-control/src/index.ts#L39-L157
[S2]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/index.ts#L294-L429
[S3]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/manager.ts#L503-L619
[S4]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/manager.ts#L1167-L1323
[S5]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/team/agent-team/src/index.ts#L32-L161
[S6]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/team/tool-agent-team/src/index.ts#L23-L234
[S7]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/team/agent-team/src/task-board.ts#L42-L259
[S8]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/team/agent-team/tests/team.spec.ts#L107-L194
[S9]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent-spawn-in-process/src/index.ts#L32-L54
[S10]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent-fork-in-process/src/index.ts#L38-L78
[S11]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/manager.ts#L300-L420
[S12]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/child-agent.ts#L39-L282
[S13]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/manager.ts#L823-L867
[S14]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent/src/index.ts#L45-L260
[S15]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/tests/sibling-messages.spec.ts#L131-L273
[S16]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/bundle/base/cordis.patch.yml#L363-L405
[S17]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/bundle/web-app/presets/standard.patch.yml#L89-L116
[S18]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/index.ts#L185-L198
[S19]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/team/agent-team/src/projection.ts#L104-L150
[S20]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/team/agent-team/src/journal.ts#L39-L74
[S21]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/team/agent-team/src/task-view.ts#L16-L55
[S22]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/team/agent-team/README.md#L188-L203
[S23]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/preset/agent-preset-registry/src/index.ts#L265-L332
[S24]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent/src/preset-selection.ts#L18-L75
[S25]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/core/tools/src/index.ts#L155-L194
