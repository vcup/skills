# DSH 原生协作能力调研：team / subagent / workflow

调研日期：2026-11-16（UTC）。本次仅阅读源码与工具定义，不实现适配、不启动实验代理、不执行 ensemble 方法，不写 STATE，不修改产品代码。

## 证据范围与版本

- **已验证事实（获取记录）**：容器内通过 Python HTTPS 读取 [npm 官方 metadata](https://registry.npmjs.org/@deepseek-ai%2fdsh/latest)，确认 `@deepseek-ai/dsh` 的 repository 是 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，当时 npm `latest` 为 `0.2.2-rc.1`，metadata 无 `gitHead`。这不是当前运行实例的版本证明。
- **已验证事实（实际阅读）**：父代理按用户后续明确指示挂载了用户 checkout；本研究实际阅读的是容器可访问的 [deepseek-harness checkout](/home/vcup/projects/deepseek-harness)。`git log -1` 得到 `39163dd30f703a79079e2d2446545cff3c453738`，提交日期 `2026-11-13`，origin 为上述官方仓库；与本次 GitHub [HEAD 查询](https://api.github.com/repos/deepseek-ai/deepseek-harness/commits/HEAD)所得 SHA 一致。[CLI package manifest][cli-version] 写的是 `0.2.2-rc.3`。`git status --short` 无 tracked 修改，仅三个未跟踪目录 `.session-repair-input/`、`.session-repair-output/`、`.session-repair-work-6ckoak71/`；没有阅读这些目录。
- **已验证事实（操作边界）**：初始对官方仓库的 clone 尚未完成即因父代理提供用户 checkout 而取消，已收集 killed 结果；没有把该不完整副本作为证据。没有读取运行时声称的 `/usr/local/lib/node_modules/@deepseek-ai/dsh/` 安装源码；该路径不可见的事实来自父代理此前检查。所有命令在同一 default Podman 容器执行，未声称存在 host shell，未申请提升权限。
- **已验证事实（当前实例公开 Interface）**：本研究用 `tool_describe` 读取了当前 `subagent`、`subagent_fork`、`workflow`、`interrupt_agent` 定义，没有调用它们。当前普通委派只公开 `cwd/description/prompt`，消息使用 `agent_id` 且描述仅父/直接子可续聊；本 checkout 的委派还公开 `name`，消息使用 `agent` 名字并允许同树成员。因此有真实的 Interface 差异，不能把 checkout 能力全部视为此实例已启用，也不能因实例未暴露某参数便断言平台没有该能力。[源码委派工具][delegate-tool]、[源码消息工具][control-tool]
- **未验证**：运行实例的精确版本、已加载插件/profile、Team mode 开关、可用 preset 与 LLM routes、存储后端、实际并发值。未做行为 smoke test，也未执行源码测试；下文“已验证”指实际读到的实现或一手文档，测试引用只表示读到了相应回归断言。
- **目标依据**：实际阅读本仓库 [ensemble SKILL](/home/vcup/projects/vcup-skills/skills/ensemble/SKILL.md#L9-L49) 与 [GLOSSARY](/home/vcup/projects/vcup-skills/skills/ensemble/GLOSSARY.md#L9-L35)，只把“独立首轮、实质差异、竞争写者独立 baseline、原生通知、证据验收”作为待适配要求，没有加载或运行该方法。已加载 research/codebase-design 指导，但按本次用户约束不再委派。

以下源码引用均固定在上述 SHA；本地 checkout 可用于逐行复查，链接不依赖会移动的 `main`。

## 结论先行

**推断/建议**：复用 DSH 原生 subagent runtime 作为执行与生命周期 Module，按需复用 Agent Teams 的共享任务板；不要再造 team/session/message runtime。一个 ensemble Adapter 的 seam 应放在“尝试的身份、独立性、产物与验收证据”上，而非包装所有底层方法。普通研究、独立审查优先 fresh spawn；fork 适合有意共享历史的后续检查；workflow 适合大规模、可重做的批处理，但不能充当持久协调状态机。

**已验证事实**：Agent Teams 有显式 `TeamService`、Team mode、TeamId、任务数据，但当前实现的 TeamId 就是根 SessionId，成员资格和运行生命周期来自 subagent 树。它不是有独立 membership/role/process lifecycle 的第二套执行系统。旧 roster/mailbox 类型仍供历史解码，不能当现行授权依据。[Team service][team-service]、[Team subsystem][team-doc]

**推断/建议**：现有能力已足够承载 ensemble 的多数执行需求；专门插件是否值得做，取决于是否需要可执行的 preset/model 选择、隔离 baseline 管理、结构化产物/证据映射和恢复核对。仅把 prompt 换个名字、复制任务板、复制通知或每次发送固定 ceremonial 状态，不能提供必要 Depth。本笔记不决定插件打包方案，插件加载与产品入口由父代理另查。

## 能力映射：硬保证与协作约定

| ensemble 需要 | 已验证的 DSH 原生机制 | 不能由该机制推出的保证 | 推断/建议 |
|---|---|---|---|
| 多个独立首轮 | spawn 不带父对话 seed；各自有 Session。[spawn][spawn] | 不自动隔离共同文件、工具或共享任务板 | 用相同 ground truth 快照和不同 assignment；首轮不发 sibling 结论 |
| 复用既有上下文 | fork 复制至最后 `turn/end`，不含当前 in-flight turn。[fork][fork] | “fork”不等于 Git worktree，也不保证首轮未见结论 | 若父已读过其他答案，后续 fork 就不宜称独立首轮 |
| 角色异质性 | spawn 可选 `agentPreset`；tool 可配置 `allowedAgentPresets`，执行期校验。[presets][preset-selection] | role 名本身没有硬语义；fork 不支持独立 preset | 读取 preset 的 persona、工具组合、模型配置后才描述角色能力 |
| 模型异质性 | 原生 service 接受 `agentOptions`；tool 可显式启用 modelSelection，执行期按 Session route policy 检查。[model selection][model-selection] | 当前实例无该参数不等于平台不支持；prompt 中写模型名不算选模型 | 发现真实 routes，再记录实际 resolved model |
| 并行与完成通知 | 原生 activation、并发 admission、自动 parent settlement、可选 caller delivery。[runtime][runtime] | 返回 id/name 只是已接收；inactive/正常结束不等于验收成功 | 保留运行结果、产物和验证三层事实 |
| 共享分工 | Team task CAS、owner、DAG、ready、writeScopes 警告。[task board][task-board] | 不加文件锁、不自动分派执行、不验证产物 | 作为可选任务视图复用，避免复制成另一套 board |
| 竞争写者隔离 | 每子代理可选 `cwd`，后续目录变化彼此独立。[cwd test][cwd-test] | cwd 不创建副本，不改变 permission roots，不禁止访问 sibling 文件 | 先准备独立 baseline/worktree，再传 cwd；需要硬隔离时依赖真实 filesystem/provider 限制 |
| 恢复 | 本地子 Session/descriptor/catalog 持久化，可向冷成员发消息恢复目标。[restore][restore] | 不保证消息 exactly-once；不恢复 workflow 脚本；preset 重启后可能变更 | 恢复先核对原生事实与产物，标记未知结果，避免盲重试 |
| 证据验收 | structured output 可做对象 schema 校验。[types][subagent-types] | schema 正确不代表结论正确；Team complete 没有验收 hook | ensemble 自己拥有 ground-truth 检查与接受/拒绝决定 |

## 1. Team 的对象、任务与可见信息

**已验证事实**：`TeamService` 注入 `subagents`，通过 `rootOf(caller)` 找到实际在线根 Agent，读取根 Session projection；Team 配置仅 `maxTasks`（默认 256）与 `defaultEnabled`（默认 false）。老 `maxMembers/maxMessageBytes/disposalTimeoutMs` 配置会直接报错，错误明确说明 teammates are subagents。[Team service:32–96][team-service]

**已验证事实**：根 Agent 才能 `setEnabled`；关闭 mode 不停止成员、不删除任务。mode 记录先 append，再 flush，flush 失败时已写入的选择仍对 live state 生效；重复相同选择用于补 flush。Team tools 在 step preparation 解析可用性，任务变更在队列执行时检查 mode。[Team service:99–118][team-service]、[Team tool:94–141][team-tool]

**已验证事实**：Task 保存完整快照，有 `pending/in_progress/completed/deleted`、revision、owner、blockedBy、writeScopes。每根树内 mutation 串行；更新必须 expectedRevision 匹配；claim 只可领取 ready 的 pending task；owner 或 lead 可 complete，root 才可 reassign；重分派目标只能是 root 或 continuable descendant。external run 不能成为此任务板的 owner。DAG 校验阻止缺失依赖、循环等。[task board:118–238][task-board]、[journal:45–74][team-journal]

**已验证事实**：`complete` 仅要求授权者与当前 `in_progress` 状态，没有“测试通过、产物存在、独立性成立”的校验。`writeScopes` 只是 normalize 后的 advisory prefix，不是锁或沙箱。`ready` 不启动 owner；task 变更既不投递 inbox，也不结束 `wait_agent`。需要显式 `send_message` 唤醒对方。[task board:179–183][task-board]、[Team policy:27–33][team-tool]

**已验证事实**：Team prompt 只注入公共协作指导，没有自动广播每个 task 内容/成员结论。现行沟通复用普通 subagent 消息；历史 mailbox pending records 不再投递。任意 live Team member 能 list/get 共享任务；root/continuable 同树成员有横向通信能力。[Team tool:27–33,102–116,143–198][team-tool]、[Team subsystem:7–28][team-doc]

**推断**：这避免了强制自动泄漏答案，但不构成盲评隔离。把 sibling 结论写进共享 task description、共享文件或主动发消息，仍会破坏 ensemble 首轮独立性。仅提示“不看”是协议约定；若要硬保证，需要真正缩小可读取资源和可通信对象的执行权限，本次未找到现成按 ensemble stage 自动切换的保证。

## 2. 普通 subagent、fork、模型与角色参数

**已验证事实**：原生 `ctx.subagents.startActivation(spec)` 是可供插件直接复用的 Interface；spec 包含执行后端 `provider`、`label/name?`、`parent`、`prompt`、`cwd?`、`agentPreset?`、`agentOptions?`、`outputSchema?`、`maxDepth?`、`signal` 与 `delivery: 'parent' | 'caller'`。返回 `childId/name/messageId?`、`result: Promise<SubagentResult>` 与 `dispose()`。启动前检查 exact live parent、provider identity、capabilities 和 schema；不支持的能力明确拒绝。[runtime:247–292][runtime]、[types:28–66,132–191][subagent-types]

**已验证事实**：执行 provider 与 LLM provider 是两种概念：前者选 spawn/fork/ACP 等 backend，后者位于 `agentOptions.provider`。`tool-subagent` 的部署配置 `provider` 固定 backend；打开 `modelSelection` 才在模型工具参数暴露 `provider/model/reasoning_effort`。显式 LLM route 必须 provider 与 model 同时给出，Session allowlist 缺省时只允许当前父 route；`modelDiscovery` 可单独开启 `list_subagent_models`，并不会自动开启 selection。[delegation config][delegate-tool]、[model selection:92–157][model-selection]

**已验证事实**：spawn capabilities 全为 true，fresh child 不继承父对话。fork 的 model/schema/depth 为 true，`agentPreset=false`；它截取截至最后 completed turn 的完整 Session 前缀，仅在初次创建捕获一次。恢复重放自己的持久前缀，不重新截取父的新历史。fork 的对话继承并不自动声明 service/tool/authority 继承语义。[spawn:32–54][spawn]、[fork:38–78][fork]、[provider contract:321–363][subagent-types]

**已验证事实**：新配置中的 `persona`/`toolFilter` 已被 `tool-subagent` 明确移除，要求在 Agent Preset 中组合 persona 与 tool plugins，再以 spawn 选择 preset。`allowedAgentPresets` 是工具执行期校验，不只是 JSON enum；不在 allowlist 的 id 会报 `PRESET_NOT_ALLOWED`。未指定 preset 时加入父当前 composition；显式指定时挂载该 preset 当前可用 revision。[delegate tool:150–159][delegate-tool]、[preset selection:49–75][preset-selection]、[child composition:177–221][child-agent]

**已验证事实**：底层 `tools.restrict({allow,deny})` 会限制 scoped registry 的执行查找，不只是隐藏文案；各层限制取交集，但当前 scope 自己注册的 tools 豁免，不能把它当 OS/file 安全策略。历史 child descriptor 的 `toolFilter` 在冷恢复时仍能应用。[tools registry:155–255][tools-restrict]、[restore:1259–1263][restore]

**推断/建议**：角色用“实际 preset + assignment”表达。需要限制一个研究员写文件时，必须检查 preset 的真实工具集合和底层文件策略；给它 reviewer 名字、使用 read-only 口吻、填 `writeScopes` 或给不同 cwd 都不构成同等级保证。工具层 model/preset allowlist 是该 Consumer 的约束；直接 service Consumer 必须自行承接相应选择策略，不能假定自动沿用 tool 的配置。

## 3. 隔离、并行与容量

**已验证事实**：本地 child 自己持有 Session、cwd、Agent scope；它仍保持父 origin/workspace metadata。创建时 current cwd 被捕获，后续父/子目录变化彼此独立，显式 cwd 可在恢复时保留。该过程没有创建 worktree、复制仓库或给每成员加文件锁。[child metadata:121–153][child-agent]、[manager creation:334–401][creation]、[cwd regression:51–87][cwd-test]

**已验证事实**：本地权限在委派时同步捕获；继承父显式 sandbox override、适用的 auto/full-access preset，审批 pin 为 `never`，一次性 grant 不被复制；捕获发生在首次 await 前。事件写在 fork seed 后，避免旧 seed 覆盖新授权快照。冷恢复从子日志回放，不重新抓父后续权限。[delegated policy:224–282][child-agent]、[materialization:826–844][materialize]

**已验证事实**：同一个 subagent tree 共用 activation pool；默认 `maxActiveSubagents=8`、`maxDepth=1`，均可配置。pool 在达到上限时拒绝 `ACTIVATION_LIMIT_REACHED` 而非排队；包括正在创建/恢复、resident、pending inbox、正在停止清理的执行；根本身不占 child slot。并发阈值与递归深度是不同控制。普通工具标记 `isConcurrencySafe=true`，可以同一模型步骤并行开始。[runtime config:185–198][runtime]、[activation pool:14–34][activation]、[subagent README:49–57][subagent-readme]、[delegation execution:274–337][delegate-tool]

**推断/建议**：竞争写者应在 dispatch 前拿到同一基线派生的独立工作副本，并以 cwd 路由；这只是文件布局隔离，若所有成员仍可访问彼此目录，尚非权限隔离。父代理正在另查容器/filesystem 插件，本文不扩大到 mount 或 provider 安全评估。不能承诺外部进程自动提供独立代码 baseline。

## 4. 消息、发现与完成结果

**已验证事实（本 checkout）**：`sendMessage` 只允许 exact live root 或 resident continuable sender，目标必须是同一树中的另一 root/continuable 成员，禁止发给自己。在线 target 收 Steer，忙时下一 step 可见，idle 时唤起新 turn；冷 target 仅恢复目标，原创建链祖先可保持 offline。消息携带真实 senderSessionId。名字解析只定位 Session，不能绕过授权。[runtime messaging:355–374][runtime]、[manager send:559–608][messaging]、[target-only regression:223–249][sibling-test]

**已验证事实**：发送成功返回的是 inbox 接收 id/confirmation，不等待对方回答；signal 只在 acceptance 前可取消，接受后不撤回。`listDescendants` 沿 parent-owned catalogs 递归，只读发现、不激活 Agent，external 为叶子，损坏/不可读 branch 有诊断。catalog 是成员身份事实，不存执行结果或完成状态；“inactive”不能推出“成功”。[runtime discovery:411–429][runtime]、[subagent README:127–147][subagent-readme]

**已验证事实**：`delivery:'parent'` 的 settlement 在资源释放、capacity 归还后投递给仍在线的直接 creator；不恢复 offline creator。idle parent 会被唤起，busy parent 得到 steer。通知含最终非空文本、structured result 与安全 diagnostic，不含全部 transcript、工具输出或 reasoning；子最后动作若是发消息给父且其后无新输入/工具调用，自动 notice 会省略重复 closing text。[settlement:1104–1142][settlement]、[message representation:78–175][notice]

**已验证事实**：`delivery:'caller'` 不给父自动 notice，由持有 handle 的调用者 await `result`。结果含 `output/structured?/diagnostic?/stopReason`，known stop reasons 为 `completed/aborted/error/max-tokens/refusal`，基础设施故障可能 reject。`completed` 定义是普通执行结束，结构化 schema 只校验数据形式，没有产物验收。[types:235–305][subagent-types]

**已验证事实**：HEAD 的 `wait_agent` 等待调用者 nextStep inbox 新输入（消息、通知、人类 steering），不消费输入，不直接等待指定代理结果。默认 30 秒，可设 10 秒至一小时；同一个 code tool call 的循环不会反复被同一待消费输入唤醒。当前实例目录没有暴露它，故只能作为 checkout 能力记录。[wait tool][wait-tool]

**推断/建议**：Adapter 应记录 attempt 与 SessionId、activation runId、产物路径/基线的映射；分别保存“执行停止原因”“有可用产物”“验收通过”。等通知即可，不重复造轮询状态机。冷恢复产生新的 activation epoch，但是否算 ensemble 新 Attempt，要看是否继承了旧结论；重用 Session 的 follow-up 通常是原贡献的继续/修订，不能宣称新的独立抽样。

## 5. 停止、生命周期、恢复的精确边界

| 操作 | 已验证事实 | ensemble 含义（推断） |
|---|---|---|
| 初始 `startActivation.signal` | 未 publication 的工作受取消；publication 后生命周期由返回 handle 管。[types:28–65][subagent-types] | 父当轮结束/取消不等于已发表子执行被清理 |
| `interrupt` / `interrupt_agent` | fire-and-return，仅向该成员发取消；本地用 `keepInbox:true`，未 claim 消息保留，已 claim 不重排；后代继续。external 停止单次执行。[interrupt:194–232][interrupt] | “已请求停止”不等于已 quiescent；不能把父中断当整树结束 |
| `activation.dispose()` | 绑定该精确 epoch，停止并等待它自己的资源清理；不停止 sibling 或 descendant。[dispose test:1788–1819][dispose-test] | 后续同 Session 的新 activation 不应被旧句柄误取消；整轮清理须跟踪全部所属执行 |
| `drainDescendants([root])` | 对 exact live roots 关闭 admission、取消 pending starts、停止树内实例并 await 清理；普通非根成员被忽略。[drain:285–297][interrupt] | 它是树根 teardown 能力，不是任意 attempt 子树的通用递归 stop |
| root wait | `waitForTreeWork` 只对根等待 progressing work、startup、cleanup；idle 且有 parked inbox 的成员可继续驻留但不阻止 host completion。[wait:246–281][interrupt] | “host 已可结束”不证明所有队列清空、task 完成或 artifact 已验收 |
| cold continuation | 验证子 own descriptor、parent catalog ancestry、live root；只恢复目标，保留创建父身份；原 provider 不必仍注册。[restore:1215–1272][restore] | 可恢复的是本地会话，不是重新自动做完此前 assignment |
| runtime restart | Activation/inbox/ownership graph 是 process-local；已接收却未写入 Session log 的消息可丢失，无自动 replay；最终 flush 是 best-effort，失败日志承认 resume 可能 stale。[limits][subagent-limits]、[flush:1145–1153][settlement] | 不能宣称 exactly-once、崩溃后全自动收敛或 durable mailbox |
| preset after restart | 恢复 saved preset id，用当前注册定义，不能保持旧 revision；缺失/broken preset 拒绝恢复。历史 persona/tool restrictions 才单独恢复。[composition recovery][subagent-readme] | 可重放对话不等于执行环境可重现；模型/工具配置应纳入复核 |

**已验证事实**：中断信号已发出但 Agent 尚未 idle 的窗口内，accepted follow-up 可能只进入 parked queue，直到另一次 waking send 才恢复；不能把第一次发送 confirmation 理解为已重新开始执行。[cancellation wake gap:238–241][subagent-limits]

**已验证事实**：`subagent/start` 与 `subagent/end` 是 observe-only lifecycle events，以 runId 配对，dispatch scope 锚定 tree root；可供插件收集生命周期，但不提供对 end 事件回传运行决策的语义。父最终答复与 task 完成也不会自动标记彼此。[runtime events:136–166][runtime]、[types:91–124][subagent-types]、[limits:240–242][subagent-limits]

**已验证事实**：Team task/mode 自身在根 Session log 中可重放，TeamId 过滤避免普通 fork 继承原 Team 授权；损坏记录使 projection 保留 last-valid state 并报 failure。写 task 若 append 后 flush 失败，会报 `TEAM_TASK_PERSISTENCE_UNCONFIRMED`，明确要求先读再重试，不能当“没发生”重发。[projection:104–149][team-projection]、[journal:57–74][team-journal]

**推断/建议**：恢复时以原生 Session/catalog/task projection 为运行事实来源，以仓库产物和真实检查为技术事实来源。协调笔记只保存必要决定和指针；不要制造第三份 live 状态。出现 uncertain persistence/message outcome 时先核对，不能把重试等价为幂等。若将来实现取消一个 ensemble invocation，必须先定义该 invocation 与 root/tree 的所有权关系，再选精确 activation handles 或 root drain。

## 6. Workflow 与普通子代理的关系

**已验证事实**：workflow 是现成 subagent Interface 的 Consumer，不是另一种 team。`PtcWorkflowRun.startChild` 调用同一 `subagents.startActivation`，固定 `delivery:'caller'`，用一次 workflow 开始时捕获的 cwd。engine 的 `provider/subagentProvider` 选择执行 backend；脚本 `agent(...,{provider,model})` 只覆盖 LLM route。每调用一个 `agent()` 才创建一个新 child；pipeline 的阶段不是同一个自动延续的子 Session。[workflow host:215–241][workflow-host]、[workflow engine:34–46,136–176][workflow-engine]

**已验证事实**：脚本 `agent` 仅支持 `label/phase/schema/provider/model`，`effort/isolation/agentType` 明确 deferred，`cwd/agentPreset` 等未知 opts 会失败。`agent` 正常结果是 final text 或验证过的 structured object；child 非 completed 返回 null，基础设施/创建故障为 fatal；parallel 是所有 thunk 的 barrier，pipeline 对每个 item 顺序走 stage、items 之间无 barrier，普通 stage throw 丢弃该 item 后续阶段。[workflow runtime:32–35,168–287,290–345][workflow-runtime]

**已验证事实**：workflow 有自己的 FIFO concurrency gate（默认 auto ≤16）、total-agent cap（默认 1000）、item cap（默认 4096），但仍受 subagent shared activation pool 限制。后者满时拒绝而不排队，所以只调 workflow 并发不能保证 admission 成功。[workflow engine:108–149][workflow-engine]、[runtime slots:148–197][workflow-runtime]、[activation pool][activation]

**已验证事实/范围限定**：本实现的 workflow child start 没有传 `maxDepth`，也不走 `tool-subagent` 的 Session model/preset selection policy。原生 service 的 depth cap 是可选请求字段。因此普通 `subagent` 工具的深度/模型选择约束不能直接推为 workflow 的同等硬约束；这仅是源码观察，未实际执行绕过或进行策略测试。[workflow host:218–233][workflow-host]、[creation:337–340][creation]

**已验证事实**：workflow 脚本环境提供有限 hooks，没有公开 fs/network/timer/Node 能力；但维护文档明确 VM 不是 security boundary，实际 confinement 属于 PTC provider 与调用 Session 的 file policy，file policy 不限制网络。不能把“脚本 hooks 没有 fs”解释成写者的代码仓库已隔离。[workflow confinement:57–61][workflow-readme]

**已验证事实**：cancel 中止 PTC 程序与 pending starts，dispose 所有该 run 持有的已发布 child，晚完成的 start 也会清理；settlement 等待这些 child cleanup。每个 child dispose 仍只覆盖它的 activation，代码没有在这里对任意 child 的后代调用 root drain。[workflow host:162–180,234–239,325–335][workflow-host]

**推断**：如果 workflow child 被允许再委派，不能仅凭“workflow cancel”宣称其整个后代树已递归取消。需要使用明确的 descendant 管理策略；本次没有跑此组合实验。

**已验证事实**：engine 没有 journaling/checkpoint/resume；tool 会记录 run/member start/end，background mode 经 jobs 持有 handle，kill 转发 cancel，phase/log 仅 transient mirror。具有 persistence/query 的 local workflow children 可在之后独立继续，但 JS 控制流、阶段中间值与未完成脚本不能从这些日志恢复。workflow 的 foreground-only 文档限制指 engine 的持有者 Interface，不应误读为工具没有 background mode。[workflow limitations:124–130][workflow-limits]、[workflow tool:117–150,265–317][workflow-tool]、[workflow child continuation:71–75][workflow-readme]、[transient progress mirror:1–7,37–62](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/workflow/tool-workflow/src/record.ts#L1-L62)

**推断/建议**：不要仅为“两份独立贡献”引入 workflow。批量任务可以使用它的并发、结构化输出和取消，但需要把每个 null 当 coverage gap，不能 `.filter(Boolean)` 后忘掉失败项。重要的跨重启协调事实应在 workflow 之外保存；优先复用原生 Session/Team 与产物，不建立脚本恢复幻觉。

## 7. 外部 execution providers 与插件复用

以下是 **已验证源码能力**，不是当前实例已安装/启用清单。

| backend | 父对话 | 本地可续聊 Session | per-start capabilities | 其他配置事实 |
|---|---|---|---|---|
| in-process spawn | fresh | 有 | agentOptions、agentPreset、schema、depth | 原生 scoped composition。[source][spawn] |
| in-process fork | completed-turn seed | 有 | agentOptions、schema、depth；无独立 preset | cold resume 不 re-fork。[source][fork] |
| ACP | fresh | 无，one-shot | 上述四项均 false | command/args/env、permission allow/reject，默认 reject。[source][acp] |
| DSH SDK | fresh | 无本地 continuable session，one-shot | 仅 agentOptions | 独立进程/profile/patch/dshHome；provider/model/effort/maxTokens。[source][sdk-provider] |
| Codex | fresh | 无，one-shot | 四项均 false | instance 固定 model、native permissionMode；app-server ephemeral thread。[source][codex-provider] |
| Claude Code | fresh | 无，one-shot | 四项均 false | instance 固定 model、native permissionMode；默认 dontAsk。[source][claude-provider] |

**已验证事实**：provider 注册 Interface 明确允许同一 backend 并发 distinct starts；一次 start 的 cancellation、failure、settlement、cleanup 必须独立。外部 child 自己拥有工具/权限系统，不能从本地 child 的审批继承直接推导它们。external 仍复用公共 admission、ownership、lifecycle、result，但不支持 sendMessage continuation。[provider contract:313–363][subagent-types]、[external continuation rejection:107–119][activation]

**已验证事实**：原生插件可以消费 `ctx.subagents` 创建、发送、发现、取消并观察 lifecycle，也能消费 `ctx.agentTeams` 的 task/mode；Team 与 workflow 本身已展示这种复用方式。provider registry 可扩展新 backend，现有 accepted handle 不因 provider 移除而撤销。[runtime][runtime]、[Team service][team-service]、[workflow host][workflow-host]

**推断/建议**：若未来做 ensemble 专门插件，优先做 Consumer/Adapter 而非新执行 provider。只有确有不同隔离或执行后端需求时再添加 provider；普通“角色”优先 preset。独立尝试的 prompt 输入、artifact/evidence 关联与 acceptance 不能被 DSH task/status 代替。若需要共享任务可见性、跨成员主动领任务，复用 Team；若只需少数独立提交，不必启用共享 board 才称 ensemble。

## 需父代理明确保留的限制

1. **已验证**：本 checkout rc.3 与当前实例工具 schema 不同；最终方案必须做 runtime capability discovery，不用当前缺参数或源码存在参数来单边推定。
2. **已验证**：原生 Team = subagent 树 + 根 Session task board/mode；writeScopes advisory，complete 不验收，任务变化不唤醒。
3. **已验证**：fresh/fork 的上下文语义与 filesystem 隔离无关；首轮不可见 sibling 结论默认只是协议约定。
4. **已验证**：interrupt/dispose 非递归；root drain 是另一操作；completed、inactive、任务 completed、artifact accepted 是不同事实。
5. **已验证**：本地子 Session 可冷恢复；未日志化 inbox 无 crash replay，preset revision 不跨重启固定，workflow 无恢复。
6. **推断/建议**：先用原生 capabilities，专门插件只补这些能力未覆盖且确有价值的 ensemble 语义；不复制运行时或任务板，不把 prompt 约定写成硬保证。

## 固定版本源码索引

[cli-version]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/apps/cli/package.json#L1-L12
[team-service]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/team/agent-team/src/index.ts#L32-L160
[team-doc]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/docs/subsystems/agent-team.md#L7-L117
[team-tool]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/team/tool-agent-team/src/index.ts#L23-L234
[task-board]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/team/agent-team/src/task-board.ts#L118-L264
[team-journal]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/team/agent-team/src/journal.ts#L45-L74
[team-projection]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/team/agent-team/src/projection.ts#L104-L149
[delegate-tool]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent/src/index.ts#L45-L337
[preset-selection]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent/src/preset-selection.ts#L5-L75
[model-selection]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent/src/model-selection.ts#L92-L199
[spawn]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent-spawn-in-process/src/index.ts#L32-L54
[fork]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent-fork-in-process/src/index.ts#L38-L78
[runtime]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/index.ts#L136-L429
[subagent-types]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/types.ts#L28-L363
[child-agent]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/child-agent.ts#L121-L282
[creation]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/manager.ts#L300-L401
[messaging]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/manager.ts#L503-L614
[materialize]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/manager.ts#L800-L919
[settlement]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/manager.ts#L1100-L1164
[restore]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/manager.ts#L1215-L1272
[interrupt]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/manager.ts#L189-L297
[activation]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/activation.ts#L14-L159
[notice]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/continuation-messages.ts#L78-L175
[control-tool]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent-control/src/index.ts#L39-L155
[wait-tool]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent-control/src/wait-agent.ts#L20-L115
[subagent-readme]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/README.md#L28-L148
[subagent-limits]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/README.md#L232-L242
[tools-restrict]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/core/tools/src/index.ts#L155-L255
[cwd-test]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/tests/working-directory.spec.ts#L51-L87
[sibling-test]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/tests/sibling-messages.spec.ts#L223-L249
[dispose-test]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/tests/continuation.spec.ts#L1788-L1819
[workflow-engine]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/workflow/workflow-ptc/src/index.ts#L34-L191
[workflow-host]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/workflow/workflow-ptc/src/host.ts#L162-L336
[workflow-runtime]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/workflow/workflow-ptc/src/runtime.ts#L32-L345
[workflow-tool]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/workflow/tool-workflow/src/index.ts#L117-L317
[workflow-readme]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/workflow/workflow-ptc/README.md#L55-L93
[workflow-limits]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/workflow/workflow/README.md#L124-L130
[acp]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent-acp/src/index.ts#L24-L119
[sdk-provider]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent-dsh-sdk/src/index.ts#L33-L165
[codex-provider]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent-codex/src/index.ts#L35-L98
[claude-provider]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent-claude-code/src/index.ts#L37-L114
