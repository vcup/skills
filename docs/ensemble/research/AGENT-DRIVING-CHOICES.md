# 原生代理的驱动选择

> **历史驱动选择研究。** 技术核对使用 `39163dd30f703a79079e2d2446545cff3c453738` 开发快照，不是正式 rc.3 或 rc.4 发布提交。现行基线为正式 rc.4 `3f321d32bfe382212a8ed8785c1d47a5a300aa23`；以[原生代理接入](<../NATIVE-AGENTS.md>)及[当前方法指引](<../../../skills/ensemble/README.md#choose-how-to-drive-native-agents>)为准。版本差异见[发布基线](<RC4-BASELINE.md>)和[代理复核](<RC4-AGENTS.md>)。下文保留原选择矩阵、反例及建议形成过程，源码事实不等于当前部署的运行结果。

原研究建议：统一称原生代理；Member 是参与者，Attempt 是有问题、基线与可审贡献的一次尝试。Lead 应积极委派、观察中间产物、教学和整合，并按任务选择 fresh subagent、fork 或继续已有成员。它们是上下文与执行选择，不是三个领域实体，也不需要独立 teammate 层。当时用户纠正是原研究的范围依据；现有 [Member/Attempt 定义](<../../../skills/ensemble/GLOSSARY.md>)、[Lead 职责](<../../../skills/ensemble/SKILL.md>)与这一方向一致。

**选择矩阵。** 下表是场景判断，不是自动路由器或必填表。fresh/fork 的技术事实限于下述目标 DSH 本地后端；其它 harness/backend 需核对实际能力。共同任务包沿用已有问题、共同事实/基线、范围、产物、完成检查及早期可审切片，不增格式。[任务包依据](<../../../skills/ensemble/SKILL.md#2-compose-result-changing-attempts>)

| 判断维度 | fresh subagent：新对话 | fork：继承已完成轮次 | 继续已有成员 |
|---|---|---|---|
| 独立性 | 适合另开未接触争议答案的评估；仍检查 prompt、共享文件、消息和任务描述是否泄露结论。fresh 本身不证明独立。 | 若继承的历史只有共同事实/一般方法，也可支撑独立首轮；若含被比较答案或推理，不计作对它的独立评估。 | 适合深化、修订；同一问题上的指导续做不新增独立样本。成员身份既不能证明、也不能单独否定另一问题的独立性，要看相关已暴露信息。 |
| 上下文预算 | 不复制父对话，适合范围清楚或父历史庞杂；代价是整理任务包、重读必要材料。 | 避免手工重述长背景，但子请求仍承担继承历史的 token；前缀缓存可能复用，不等于上下文免费。 | 保留已有调查与方法，减少重新上手；历史也持续增长。接近预算、旧假设过多或恢复困难时，考虑新代理加精简交接。 |
| 输入完整性 | 任务包须自足，并给必要的权威资料及版本；不必全文复制可授权读取的资料。不能为“独立”省略要求和事实。 | 继承只到最后一个完成轮次，当前轮新增要求必须明写；之后父会话变化不自动同步。继承历史也可能过期。 | 提供本次变化、当前候选和下一可审结果；确认旧观察仍适用，不能把“记得”当当前事实。 |
| 教学与续做 | 适合未暴露答案的复核或可独立交接的新任务；可在首轮后继续指导此代理，不必重新创建。 | 适合需要完整既有讨论的后续分析、复核、接手；若已继承示范答案，按 guided revision/知情复核处理。 | 通常更适合让原成员定位失败步骤、修复并应用到未教过的新例；另留未继承争议答案的评估路径。 |
| 工具、通信、共享任务与权限 | 按实际 preset、工具和授权选用；目标 local spawn 可独立选 preset，也能通信、续做、参与获准共享任务。 | 对话继承不等于权限继承；目标 fork 不支持独立 preset 选择，但同样能通信、续做。 | 继续前核对所需工具与授权是否仍可用；既有身份/旧任务 owner 不能代替所需档案授权或写入范围。三者都分别检查工具可见、操作许可、通信对象范围及可选 Team 模式。 |
| 生命周期与持久性 | 目标 local spawn 有可持久会话，首个结果返回后仍可接收后续消息；不能概括成一次性。 | 目标 local fork 同样可续做；种子只在创建时捕获，冷恢复不是重新复制父会话。 | 需要原生支持继续/恢复及有效身份、会话和环境；inactive 不等于成功，送达不等于处理，存有 transcript 不等于进程常驻或消息不丢。 |

独立性与教学依据：[首轮信息规则](<../../../skills/ensemble/SKILL.md#3-produce-and-coach>)、[一般方法/示范答案的区别](<../../../skills/ensemble/README.md#coach-a-working-method-then-test-transfer>)、[共享文件也会泄露](<../DOMAIN-MODEL.md#3-lead-如何教而不消除独立性>)。输入与恢复依据：[权威、范围和寿命](<../../../skills/ensemble/PATTERNS.md#trace-authority-and-state>)、[从检查点恢复](<../../../skills/ensemble/PATTERNS.md#recover-from-a-checkpoint>)。上下文/工具/生命周期依据见下段源码核对。

实用取舍有三个反例：父历史已含偏好答案时，需要独立判断可选 fresh，但把该答案贴进其任务包仍会锚定；长历史主要是共同事实时，fork 可能比遗漏需求的手工摘要更合适；成员已有可审错误时，继续指导并验新例通常比重新派一个“更强”代理更能判断教学效果。后两种也不能因节省交接而放弃独立复核。共同文件系统下的竞争写入仍需真实隔离，`cwd`、scope 标签或 task owner 都不是文件锁。[方法依据](<../../../skills/ensemble/README.md>)、[写入隔离](<../../../skills/ensemble/SKILL.md>)、[共享任务警告](<https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/team/tool-agent-team/src/index.ts#L26-L33>)

**历史目标源码核对。** 原研究按当时实施准备所列 `39163dd30f703a79079e2d2446545cff3c453738` 读取源码，未执行 Git 或另行核对 checkout SHA；以下是原读取范围的静态事实，不是某部署已通过的验证。[现行实施准备](<../IMPLEMENTATION.md#固定源码依据>)已改用正式 rc.4。下列引用保留旧 SHA 以免把原观察冒充发行版复核；后续发行复核见[RC4-AGENTS](<RC4-AGENTS.md>)。

- [spawn provider](<https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent-spawn-in-process/src/index.ts#L38-L53>)声明 `inheritsParentContext=false`，实现 `prepareContinuable()`；[fork provider](<https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent-fork-in-process/src/index.ts#L38-L77>)截取截至最后 `turn/end`（含该事件）的完整前缀，也实现可续做准备。fork 首次调用前无完成轮次时，其 seed 为空。工具文案按后端可续做能力说明是否接受后续消息，而非按 fresh/fork 名称决定。[工具分支](<https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent/src/index.ts#L203-L218>)
- fresh 不复制父历史，但仍有自身 prompt/tool/context 成本；fork 在子请求中复制保留的历史，同 provider/model 的相同前缀可能复用缓存；二者都只把结果/消息送回父会话。[spawn token 说明](<https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent-spawn-in-process/README.md#L105-L127>)、[fork token/cache 说明](<https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent-fork-in-process/README.md#L108-L130>)
- 目标 [send_message 工具](<https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent-control/src/index.ts#L43-L81>)使用 `agent` 树内地址；[执行器](<https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/manager.ts#L559-L618>)从真实调用者解析活跃根、核对创建链，并向同树成员投递。不能由“上下文不共享”推出“不能通信”；也不能由“有地址”推出任意跨树通信权。`wait_agent` 等调用者 inbox，不是在证明特定贡献已采纳。[等待实现](<https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent-control/src/wait-agent.ts#L90-L115>)
- 目标 Team 是可选共享任务板：默认关闭，根会话模式决定可用性；源码直接写明 `teammates are subagents`。创建/通信复用已有子代理工具；领取要检查任务 revision、ready 和 owner，修改权限按动作判定。任务变化不自动唤醒成员，write scope 仅供提示。[Team 身份/开关](<https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/team/agent-team/src/index.ts#L45-L97>)、[任务权限](<https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/team/agent-team/src/task-board.ts#L124-L203>)、[工具说明](<https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/team/tool-agent-team/src/index.ts#L23-L33>)。无 Team 时仍可用获准的原生代理/消息，不能把可选 task 工具变成 ensemble 准入条件。
- spawn 可独立选 preset，fork 继承 composition；对话历史与工具/authority 继承是不同问题。子代理固定委派权限，审批策略钉为 `never`，不继承一次性扩权。[preset 行为](<https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/child-agent.ts#L177-L205>)、[委派权限](<https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/child-agent.ts#L224-L258>)。档案 read/submit grant 属 ensemble 执行器的独立授权要求，不能由 native tree、fork 或 task owner 推导。[档案授权设计](<../ARCHIVE-DESIGN.md#写入权限>)
- 本地 spawn/fork 支持持久会话与冷恢复；外部后端是否一次性须按 provider 区分。冷恢复核对 continuable descriptor、创建链与保存的 preset；仍要求可用原生运行环境。跨进程常驻状态不共享，已接收但尚未入日志的消息可能在崩溃时丢失，不能把可恢复说成永不丢消息。[本地/外部区别](<https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/README.md#L59-L78>)、[恢复执行器](<https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/src/manager.ts#L1215-L1269>)、[持久性限制](<https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/subagent/README.md#L232-L241>)

**运行证据边界。** 原研究未建立完整的同级通信、共享任务、持续教学或冷恢复验收；矩阵中的后端结论来自固定源码。迁移保留以下通用限制，不保留具体会话地址、安装目录、工具清单和部署配置。

| 项目 | 需分别核对的事实与局限 |
|---|---|
| 可地址身份 | 使用原生创建返回的可寻址身份和合法列表；环境中的 Session id 不能未经核对就当成工具地址，临时路径也不提供身份权威。 |
| 直接通信 | child→parent delivery 只证明请求被接受，不证明处理完成或 sibling 可达。某部署的 `agent_id` 直系接口不能与目标快照的 `agent` 树内地址接口混用。 |
| 工具与权限 | 工具可见不证明剩余委派深度、执行许可或已加载版本；源码副本不能替代运行安装版核验。访问不可用时保留未知，不绕过权限求证。 |
| sibling / shared task | 同级往返和共享任务读/claim/complete 须分别验证；普通 `todo_write` 可见不证明共享 task 能力。探针使用授权的独立成员/任务对象，不改变已有工作所有权。 |
| 持续与冷恢复 | 启动后能工作或发消息不证明 idle 续做、进程重启、冷恢复或消息持久性；每项需实际生命周期证据。 |

**当时提出的最小规范变化。** 下列建议保留其理由和覆盖范围；相关内容已由现行[方法指引](<../../../skills/ensemble/README.md#choose-how-to-drive-native-agents>)、[原生代理接入](<../NATIVE-AGENTS.md>)及[路线图](<../../../ROADMAP.md>)承接，不能把它们当成今天仍待执行的逐条修改指令。原建议不新增模板、字段层级、roster、spawn wrapper 或第二任务板；保留教学和授权约束，把错误扩张纠正回实际驱动选择。

1. 在 [SKILL 的编组/任务包段](<../../../skills/ensemble/SKILL.md>)加入以下一段；已有首轮独立和续做规则不再重复扩写：

   > Lead 应主动使用原生代理承担有可审产物的工作。按首轮已暴露信息、上下文预算、任务包完整性、教学续做需要，以及实际工具、通信、共享任务权限和生命周期能力，选择新对话、继承上下文或继续已有成员。任何驱动方式都不自动证明独立性，也不自动授予权限。

2. 将本矩阵压缩后放入现有 [README 的代理选择实践](<../../../skills/ensemble/README.md#choose-how-to-drive-native-agents>)，作为唯一解释落点；[PATTERNS](<../../../skills/ensemble/PATTERNS.md>)只需在独立产出与教学两处引用，不增加“fresh/fork/teammate”模式卡。[GLOSSARY](<../../../skills/ensemble/GLOSSARY.md>)保持 Member/Attempt；需要中文释义时统一“原生代理”，不新增 Teammate 实体。
3. 收束 [ROADMAP D12](<../../../ROADMAP.md#31-设计决定归属与验收交接>)、当时的 P3 独立 teammate 交付段（现为[原生协作交付](<../../../ROADMAP.md#p3交付完整协调表达原生协作与环境配置>)）与 [C16](<../../../ROADMAP.md#5-全承诺覆盖与验收责任>)：保留标识用于追踪，名称改为“原生代理驱动与续做适配”，删除把 teammate 作为独立交付层的表述。保留身份绑定、工具/档案权限、续做、失败和恢复的必要验收；Team task 仅在确有需求且启用时验证，复用原生所有者。共同验收不再以独立 teammate 产品或任务板存在为前提。
4. 在现有 [领域身份说明](<../DOMAIN-MODEL.md#1-身份与权威>)和 [实施执行选择](<../IMPLEMENTATION.md#2-原生执行选择保持原生>)补充一句：绑定原生返回的稳定身份，按当前接口寻址；fresh/fork/continuation 只说明本次驱动及上下文来源，执行/任务生命周期由原生拥有。沿用现有验收记录区分源码支持、工具可见、真实调用成功，不再新增能力台账。

最小反例验收可并入已有检查：fresh 收到答案后不能冒称盲评；fork 当前轮要求未传入时不能冒称输入完整；本地 fresh 首轮后可继续教学；共享任务可领取不代表档案可写；已送达/已结束都不自动等于已采纳。前两项检验方法信息流，后三项须在目标原生环境实际运行；本研究未声称它们已经通过。
