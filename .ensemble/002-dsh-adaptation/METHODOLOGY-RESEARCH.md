# Ensemble 方法论复核：异构模型、独立尝试与持久协作

作者：methodology；共享任务：task-1。调研日期：2026-11-16（UTC）。本轮仅探索，本文中的建议均未实施。

## 核心判断

**ensemble 应优先组织能暴露不同模型盲点的尝试，再通过独立观察、比较和修订改进共同交付物；Team 提供工作协调，协作者的身份和通信由具体运行时承载。两者可以重叠，不能用“ensemble=fresh、Team=复用”作为分类边界。** 本会话有具名持久成员；所读 checkout 则由 Team 复用 subagent 身份与通信。fresh 是减少结论继承的可选手段，复用适合延续有价值的知识；决定因素是当前问题需要哪一种贡献、参与者已经看过什么，以及怎样核对结果。

现行方法已经包含大部分值得保留的价值：异构模型、避免首轮锚定、依事实取舍、完整覆盖目标、修订后重新观察。但执行契约对模型差异的优先级较弱，术语又把 member 与 attempt 等同，容易使这些价值滑向“换几个角色、多开几个 agent”。应修正这两个问题，而不是把 OMP 的组织外形复制到 DSH。

以下判断区分三类依据：**观察**指实际读到的文档、源码或工具契约；**推论**指这些事实支持的解释；**建议**指下一轮可选择的设计。五个场景是思想反例，未运行产品实验，也不声称模型多样性收益已经由本轮实测证明。

## 1. 阅读范围与证据边界

独立读取了 [方法说明](</home/vcup/projects/vcup-skills/skills/ensemble/README.md>)、[执行契约](</home/vcup/projects/vcup-skills/skills/ensemble/SKILL.md>)、[模式目录](</home/vcup/projects/vcup-skills/skills/ensemble/PATTERNS.md>)、[词汇表](</home/vcup/projects/vcup-skills/skills/ensemble/GLOSSARY.md>)、[状态模板](</home/vcup/projects/vcup-skills/skills/ensemble/STATE-TEMPLATE.md>)，三个角色文件及 OMP adapter 与测试。未以此前设计稿为前提，未读取其他成员的研究结论。

| 证据层 | 本轮观察 | 能支持什么；不能支持什么 |
|---|---|---|
| 技能工作区 | HEAD `689972f5911aaa0d14f11edaca0990a13443e5c9`；相关初版 `88c9063f18f9f09d1bbf045969a387f4d39348ae`，重设计 `e6503670237fa6ed60a6f8a9567276895fffe755` | 可证明方法规则如何变化；不能仅由提交标题推定作者心理动机 |
| OMP 适配层 | [适配说明:13](</home/vcup/projects/vcup-skills/adapters/omp/README.md#L13>)、[实现:5](</home/vcup/projects/vcup-skills/adapters/omp/index.ts#L5>)、[测试:19](</home/vcup/projects/vcup-skills/adapters/omp/index.test.ts#L19>) | 可证明当前 adapter 主要提供受路径约束的原子状态写入；未调查 OMP 引擎本身，不能断言下文所有规则都是 OMP 技术上强迫的 |
| 只读 DSH checkout | `git rev-parse HEAD` 确认为 `39163dd30f703a79079e2d2446545cff3c453738` | 可证明该提交的实现与文档，不等于本会话实际部署版本 |
| 本会话可调用工具 | 实际读取 `spawn_teammate`、`send_message`、`list_agents`、`wait_agent`、`team_task_get/update` 的 schema；实际领取 task-1 | 是本轮执行的直接契约；本轮未创建其他 agent，未实验 cold resume、模型路由或跨轮恢复 |

历史核对采用只读 `git show`、`git log`；没有联网、运行产品实现或测试，没有修改技能、词汇表、代码或配置。本轮按 Lead 分工由我直接完成研究笔记；用户真正限定的是只探索不实现，另开代理和更新词汇表均未作为本轮必要工作。

## 2. 历史已经做过一次去仪式化，但模型核心随之变弱

初版 `88c9063` 的执行契约包含：主协调者不得成为主要调查者/实现者；每位成员返回规定格式的状态更新；不能写状态的成员需要机械 write-proxy；缺失 role→model 映射时询问用户；状态与代码分别提交。这些是当时的协调方案。它同时明确写有：

> “Prefer different models when the runtime mapping and suitable roles allow.”

重设计 `e650367` 删除协调者禁做技术工作、机械写代理与规定状态回报，改为发现 harness 原生能力，允许协调者直接调查、实现和集成；加入当前原子状态写入工具。这是实质性减负，不应恢复旧规来适配 DSH。

但同一提交也删除了执行契约中的上述模型优先句，以及旧方法说明中的：

> “Without model diversity, use materially different roles and assignments and record the loss.”

当前 [方法说明:18–28](</home/vcup/projects/vcup-skills/skills/ensemble/README.md#L18>) 仍要求在重要独立尝试中使用真正的模型差异，并明确 assignment 不能替代模型或角色差异；[执行契约:21–25](</home/vcup/projects/vcup-skills/skills/ensemble/SKILL.md#L21>) 却把 model、role、approach、source、lens、redundancy 列成满足“material difference”的并列选项。**观察是文本强度不一致；推论是只读执行契约的 agent 可以用不同任务标签满足规则，完全跳过可用的模型异构性。** 这不证明现行方法禁止模型多样性，却足以说明它不再可靠地优先该价值。

同一历史中，member 的“one independent attempt”定义没有被修正。状态模板从“Member / attempt”改成“Attempt”，示例标识仍是 agent/task，不能区分一个可续聊成员的首次研究、看到其他结论后的修订和下一问题的重新调查。

可复核的历史命令：

```sh
git show 88c9063:skills/ensemble/SKILL.md
git show 88c9063:skills/ensemble/ROLE-CONTRACT.yaml
git show e650367 -- skills/ensemble/SKILL.md skills/ensemble/README.md skills/ensemble/GLOSSARY.md skills/ensemble/STATE-TEMPLATE.md agents adapters/omp
```

这组证据支持“将历史执行方案重新分类”，不支持“所有旧规则均源于 OMP 无能”。例如 state/code 分开提交本来就是方法作者选择的工作流，当前 adapter 根本不执行 Git 操作。

## 3. 异构模型应有优先级，assignment 多样性承担另一种工作

建议恢复一条清晰原则：**对承担重要判断的独立尝试，在可用、获准且适任的模型中优先引入真正的模型差异；角色与 assignment 用于补足覆盖和观察方法，不能冒充模型差异。**

这里的“优先”不是无条件选较差或不适任模型，也不是每个琐碎动作都必须调用两家模型。先确定必须覆盖的结果和能力，再为关键判断分配跨模型观察；其后才决定额外的领域分工、方法差异和同配置重复。模型不可用时，应直说这是同模型的多视角或重复尝试，并说明残余的共同盲点。是否仍足以交付，取决于具体证据和缺口的后果，不能机械地把能力缺失都升级为阻断。

这一区分有三项依据：

- [方法说明:104–116](</home/vcup/projects/vcup-skills/skills/ensemble/README.md#L104>) 已明确同模型重复不解决模型特有盲点，并把先独立形成观察作为防锚定措施。
- [scout](</home/vcup/projects/vcup-skills/agents/ensemble-scout.md#L1>)、[reviewer](</home/vcup/projects/vcup-skills/agents/ensemble-reviewer.md#L1>)、[worker](</home/vcup/projects/vcup-skills/agents/ensemble-worker.md#L1>) 配置了不同工具和行为，但没有直接指定模型。换角色名称不能证明换了模型；工具列表也不自动证明路径级写入隔离，例如 reviewer 仍有 bash。
- DSH checkout 的 [模型选择契约:92–156](</home/vcup/projects/deepseek-harness/packages/subagent/tool-subagent/src/model-selection.ts#L92>) 区分工具是否允许选型与 Session 授权路由；没有 policy 时只能显式选择父路由。[模型发现:39–97](</home/vcup/projects/deepseek-harness/packages/subagent/tool-subagent/src/list-models.ts#L39>) 也按授权路由过滤。源码存在选型能力，不等于当前会话已授权多个模型，更不等于具名 Team 创建工具能传入它们。

模型身份也需要诚实表述：不同 provider 路由可能指向同一底层模型；同一模型的不同 reasoning effort 是配置变化；不同模型同样可能共享训练来源、惯常框架和错误。异构性是在降低对单一路径的依赖，不能把两份一致回答转换成统计上独立的两份证据。

对一个关键问题，跨模型重复同一清晰契约有时比“一个模型只查性能、另一个只查安全”更能暴露模型差异。后者扩大覆盖，却把模型与任务差异混在一起，不能由结果差异判断是哪种因素有效。无需为所有任务做受控实验，但在讨论某项异构性是否有贡献时必须知道这个限制。

## 4. member、session、attempt、task 需要拆开

现有 [词汇表:5–15](</home/vcup/projects/vcup-skills/skills/ensemble/GLOSSARY.md#L5>) 把 ensemble 定义为 independent members，member 又定义为 one independent attempt。这个压缩对一次性调用看似方便，在可续聊运行时会产生三种错误：把同一成员的新一轮对话算成新的独立样本；把返回过结果的成员视为已经“用完”；为了满足方法术语而重复创建本可续用的身份。

建议使用下列概念边界。它们是待讨论的词义，不是本轮改动后的正式词汇表：

| 概念 | 关注对象 | 与其他对象的关系 |
|---|---|---|
| Member | 可分派、可联系的协作者身份及其能力 | 可以承担多个任务与尝试；是否持久由 harness 决定，身份本身不承诺独立 |
| Session/context | 某个协作者可继承、恢复的交互记录与上下文 | 影响已经接触哪些事实和结论；独立进程、新 ID、重新激活都不能自动清除既有认知依赖 |
| Attempt | 围绕一个明确问题和基线，产生候选或观察的一次有界工作 | 可能跨多轮对话；可以独立起始，也可以显式继承先前成果；后者不能作为新增的独立重复计数 |
| Contribution | 实际可用于交付或判断的产物、观察、修订 | 一个 attempt 可产出多项 contribution；后续修订可以保留原有来历 |
| Task/assignment | 对工作范围、目标和验收的分派 | Team task 是协调记录，不天然等于一次 attempt；重开任务不产生独立性 |
| Team | harness 提供的协作组织与任务协调能力 | 可执行普通分工，也可承载 ensemble；两种 DSH 版本有不同成员机制，见第 7 节 |
| Ensemble | 针对共同结果组织差异、进行有依据取舍并演化交付物的方法 | 可以在 Team 内进行，也可用不需要共享任务板的原生代理完成 |

将 attempt 扩成中性“有界尝试”比要求所有 attempt 都独立更易描述演化。但这是实际的术语选择：若团队希望保留“attempt 必定独立”，则后续续聊应称 refinement/continuation，且明确不另计独立 attempt。两种词法均可，**不可保留 member=attempt，也不可让新 turn 自动新增独立样本**。

“独立”应当限定到具体问题与信息暴露，而不是人格标签。每次承重比较只需知道：共享了什么原始事实/契约；是否已经看到其他候选的结论；工作基线是否被其他人改动；预计提供哪个不同模型、观察方法或重复检查。无需为每句话建立污染图谱，重要的是不作超出已知信息流的独立性宣称。

DSH checkout 已直接说明 fork 继承的是父会话完成轮次，[fork 实现:38–77](</home/vcup/projects/deepseek-harness/packages/subagent/subagent-fork-in-process/src/index.ts#L38>) 只在创建时截取一次前缀；后续恢复复用该子会话记录。相对地，[spawn 实现:38–53](</home/vcup/projects/deepseek-harness/packages/subagent/subagent-spawn-in-process/src/index.ts#L38>) 不带父对话种子，却仍接收协调者给出的 prompt，并处于可读共享文件的环境。因此 fresh 降低一种继承渠道，不保证完全无锚定；fork 若只继承相关原始事实，也未必破坏对某个尚未形成结论问题的首次独立判断。

## 5. 哪些是价值，哪些是执行策略

| 当前规范 | 应保留的价值/约束 | 可替换的执行策略与建议 |
|---|---|---|
| 异构模型、独立贡献 | 暴露单一模型/路径可能共同遗漏的内容；独立性声明符合实际信息流 | 不用固定角色名或 agent 数量证明异构；对关键判断恢复模型差异优先级 |
| 至少两个独立 attempts | ensemble 必须有超出单一路径的可比较或互补贡献 | 不是每次修改、续聊、检查都新建两个成员；不把一位作者的连续回答当两个独立样本 |
| 首次产出前不分享兄弟结论 | 避免锚定和结论传染 | 可以共享原始事实、约束和基线；随后针对性交流是合法的演化，fresh/fork/复用按目的选 |
| 状态可恢复 | 接手者能找到目标、覆盖缺口、证据、当前候选和下一步 | 固定 Markdown 文件名、编号、表头、每次 dispatch 前写入不是方法本质；优先原生持久状态，补其缺少的决策/证据指针 |
| 用 VCS 保存状态，且与代码分开提交 | 有用结论不随对话消失；候选及证据版本可辨认 | Git 提交及提交拆分是仓库政策，不能作为 ensemble 普遍成立的条件；持久 Session/任务板不天然是低级替代 |
| coordinator/scout/reviewer/worker | 责任清晰，必要时生产者与观察者分离 | 固定角色分类、工具模板与“协调者不得写代码”不是核心；当前契约已允许协调者做实质工作 |
| 不固定轮数、按信息价值继续 | 需要新证据才增加成本；修订影响到的判断重新检查 | round、population、固定 reviewer 矩阵属于可选策略；不以几轮无新发现或全员同意证明完成 |
| 验收与关键检查 | 对用户所要结果、完整边界及当前候选有足够证据；关键未观察项不能假称通过 | 具体验收项来自当前交付物；本轮静态设计调研不要求运行实现，代码交付不能只交研究报告；任务完成、成员停止都不是质量验收 |
| 写入隔离、所有权 | 避免候选相互污染与共享修改冲突 | competing candidates 需要可信基线隔离；互补的并行只读研究不需要 worktree；Team write scopes 是协调提示，不能宣称锁 |
| 等通知、不重复轮询 | 等待实际新信息，避免无效消耗 | 具体 wait、消息、唤醒语义由运行时契约决定，不能把一个版本的行为编码成通用方法 |

依据分别见 [执行契约:9–49](</home/vcup/projects/vcup-skills/skills/ensemble/SKILL.md#L9>)、[状态模板:3–39](</home/vcup/projects/vcup-skills/skills/ensemble/STATE-TEMPLATE.md#L3>)、[可选模式声明:3–11](</home/vcup/projects/vcup-skills/skills/ensemble/PATTERNS.md#L3>)、[三类就绪判断:250–268](</home/vcup/projects/vcup-skills/skills/ensemble/PATTERNS.md#L250>)。表中“可替换”是建议，不假称现有执行契约已经允许取消这些硬性步骤。

验收必须单独强调：它不是可以整体下放给工具的仪式。checkout 的 [complete 分支:179–183](</home/vcup/projects/deepseek-harness/packages/team/agent-team/src/task-board.ts#L179>) 检查授权与任务状态，然后写 completed；不判断结论真假、证据充分性或交付物是否满足用户目标。Team 擅长可靠协调，ensemble 仍须承担实质评估。

## 6. 五个具体反例

### 场景一：三个新 agent、三个角色，仍漏掉同一个死锁

条件：三个同模型 fresh agent 分别被命名为 architect、reviewer、tester，都被提示“异步入口已正确释放锁”。它们返回设计、审查和测试，全部围绕这个未经验证的前提。

反证：“新 agent + 不同角色/assignment”不必然产生可用的模型异构，也不消除协调者在提示中注入的共同假设。分工完成甚至会让共识显得更强。

更合适的组合：先将该前提恢复成待检验假设；在适任且获准的模型之间重复一项关键边界调查，再分派压力调度、锁生命周期追踪等互补观察。若模型选择不可用，明确这是同模型方案，不因角色名不同而声称弥补了模型盲点。死锁是否存在由复现/追踪判定，不靠跨模型投票。

支持边界：[模型与 assignment 区分](</home/vcup/projects/vcup-skills/skills/ensemble/README.md#L18>)、[观察取舍](</home/vcup/projects/vcup-skills/skills/ensemble/SKILL.md#L33>)。此为假想场景，未实际复现死锁。

### 场景二：fresh 审查者读了结论，fork 审查者反而只继承原始事实

条件 A：Lead 新建 fresh 成员，却在 prompt 中要求“证明方案 X 适合”，并让它先读已偏向 X 的综合结论；共享目录还暴露其他成员正在修改的候选。条件 B：另一成员从只有需求、原始 traces 和既定接口的历史 fork，独立提出原因与反例。

反证：A 的身份是新的，但已继承结论；B 的会话有历史，却不一定继承对当前争议问题的答案。不能以 fresh/fork 二分直接推导“独立/不独立”。同样，仅换模型也不会修复充满结论的提示。

更合适的组合：重要首次判断采用中性的事实包和固定基线，避免主动分发其他人的答案；如存在共享产物泄漏，按任务风险选择访问边界、快照或尚未看到结论的成员。首轮完成后可明确进入 cross-critique。不能把“请忘记旧答案”视为真正清除历史。

支持边界：[独立首轮的原意](</home/vcup/projects/vcup-skills/skills/ensemble/README.md#L114>)、[fork 种子范围](</home/vcup/projects/deepseek-harness/packages/subagent/subagent-fork-in-process/src/index.ts#L38>)、[共享工作区指导](</home/vcup/projects/deepseek-harness/packages/team/tool-agent-team/src/index.ts#L27>)。

### 场景三：发现 bug 后，原作者续聊修复，原审查者续聊复核

条件：writer 和 reviewer 已独立完成首轮。reviewer 的复现揭示状态泄漏；修复要理解 writer 已探索过的调用链，复核要使用 reviewer 原有复现与边界判断。

反证：每一轮都 fresh 会重复重建有价值的调查，且可能丢失为何某些修复不可行的信息。反过来，把两人的每次 follow-up 都算作新的独立尝试，也会虚增证据。

更合适的组合：原 writer 持续修复；原 reviewer 对既有失败机制进行针对性 recheck；当剩余风险来自双方的共同前提、或需要新的整体 readiness 判断时，再增加未被结论锚定的跨模型观察。保留依赖关系：这是“原尝试的修订与复核”，不是新的盲评样本。

支持边界：[repair/re-examine](</home/vcup/projects/vcup-skills/skills/ensemble/PATTERNS.md#L198>)、[允许继续有价值工作](</home/vcup/projects/vcup-skills/skills/ensemble/SKILL.md#L39>)、本会话 `send_message(target)` 可恢复 inactive 成员的工具契约。

### 场景四：持久 specialist 遇到全新问题，Team 内仍可做首次独立探索

条件：durable 成员此前只调查构建缓存，未见新提出的权限撤销问题；另一个模型的成员独立调查同一新问题。Lead 只共享权限契约和代码基线。或者同一 reviewer 已阅读权限方案 A，此刻被要求对 A 再给一份“全新意见”。

反证：第一种情形不应仅因成员被复用就排除其贡献；第二种情形不能仅因另开一个 Team task 或改变角色名就计作全新独立样本。独立性与“这次需要判断的问题”和已暴露结论有关。

更合适的组合：保留有用专长，对新问题说明已知上下文；关键盲评需要未知结论时选择合适的新上下文。Team 成员可跨任务复用，ensemble 的比较单位仍是具体贡献，不是 roster 的人数。若仅有同模型成员，也要明确模型多样性未实现。

支持边界：[当前 member/attempt 定义的矛盾](</home/vcup/projects/vcup-skills/skills/ensemble/GLOSSARY.md#L9>)；本会话具名持久成员契约；checkout 的 [continuable 子代理与任务所有者](</home/vcup/projects/deepseek-harness/packages/team/agent-team/src/task-board.ts#L232>)。

### 场景五：只读设计调研，不该被状态提交仪式阻塞，也不能靠任务板宣告验证完成

条件：研究对象只读，用户只要求带源码与历史的设计判断；运行时已有可恢复的任务板、会话和产物。所有 task 均 completed，但某项建议仍把 checkout 的 API 当成本会话 API。

反证：强制状态 Markdown 的固定路径和单独 Git 提交，不会增加对这个 API 判断的真实性；反过来，原生持久状态也不会自动让判断正确。若按代码交付标准强迫实现原型，又越过用户本轮范围。

更合适的组合：依据来源分别标注运行时工具契约和固定提交的源码，完成静态核对、明确未实验的部分；保留足够的决策和证据链接。若任务板缺这些信息，用一份研究文档补足，不另造第二套任务生命周期。只有用户要交付实现或某个设计论点确需实验且在授权范围内时，才安排相应验证。

支持边界：[状态文件约束](</home/vcup/projects/vcup-skills/skills/ensemble/STATE-TEMPLATE.md#L3>)、[原生任务仅提供协调字段](</home/vcup/projects/deepseek-harness/packages/team/agent-team/src/types.ts#L63>)、[任务 complete 不验收技术结论](</home/vcup/projects/deepseek-harness/packages/team/agent-team/src/task-board.ts#L179>)。本轮自身即采用该范围：只读源码与 Git 历史，不运行实现。

## 7. 当前 Team 与 checkout Team 必须分栏

两边都能支持 ensemble 所需的若干操作，但它们不是同一 API，也不能由相同工具名称推出同样的生命周期语义。

| 面向方法的问题 | 本会话真实工具契约 | 只读 checkout `39163dd` |
|---|---|---|
| 如何创建成员 | `spawn_teammate(name, description, prompt, context=fresh/fork)`；Lead 专有，具名 durable 成员 | `subagent` / `subagent_fork` 统一创建；Team 是 subagent tree 上的共享任务板 |
| 如何续用 | `send_message({target, message})`；running 在步骤边界接收，inactive 启动或恢复 turn | `send_message({agent, message})`；通过 subagent runtime 解析名字并发送；可续聊能力由 provider 决定 |
| 如何认定成员 | `list_agents` 返回 Lead 与 durable teammates；inactive 仅表示无 turn 执行，provisioning/failed 是创建状态 | 根与可达后代；历史 `team/member` roster 不赋予新任务授权；不能把本会话状态词原样套入 |
| 等待什么 | `wait_agent` 观察调用后的状态、消息或共享任务变化；不会唤醒 inactive 成员 | Team 文档明确 task/mode 变化不结束标准 wait，也不启动 idle agent，需 message |
| 写入边界 | 同工作目录与文件系统，任务 write scopes 是 advisory | 同样是共享 checkout，writeScopes 为提示而非锁 |
| 模型选择 | 实际 `spawn_teammate` schema 没有 provider/model 字段；不能借 checkout 推定本工具支持 | subagent 工具可在配置与 Session policy 允许时暴露 provider/model；发现与选择分别受控 |

checkout 依据：[Team 工具政策与移除旧配置:23–33](</home/vcup/projects/deepseek-harness/packages/team/tool-agent-team/src/index.ts#L23>)、[Team service:34–96](</home/vcup/projects/deepseek-harness/packages/team/agent-team/src/index.ts#L34>)、[消息工具:43–81](</home/vcup/projects/deepseek-harness/packages/subagent/tool-subagent-control/src/index.ts#L43>)、[Team 等待说明:79–83](</home/vcup/projects/deepseek-harness/packages/team/agent-team/README.md#L79>)、[模型参数注册:247–260](</home/vcup/projects/deepseek-harness/packages/subagent/tool-subagent/src/index.ts#L247>)。本会话依据是实际加载的工具 schemas 与注入运行时说明，不能伪造为 checkout 的源码行。

checkout 还显示普通 subagent 也不必一次性用完：[工具描述:210–218](</home/vcup/projects/deepseek-harness/packages/subagent/tool-subagent/src/index.ts#L210>) 根据 provider 是否支持 continuation 提示可续聊；[spawn provider:50–53](</home/vcup/projects/deepseek-harness/packages/subagent/subagent-spawn-in-process/src/index.ts#L50>) 把后续操作交给 continuation manager；[subagent 文档:133–147](</home/vcup/projects/deepseek-harness/packages/subagent/subagent/README.md#L133>) 说明本地历史成员仍可发现和恢复。故“普通 subagent=fresh 一次性，Team=持久复用”在这个 checkout 也不成立。

因此适配的稳健边界是**先描述需要的工作与信息边界，再选择当前真实可用的创建、续聊、模型路由、状态和通知机制**。不应为了重现 OMP 角色而先造另一套 roster、状态机或调度器；也不应把 Team 任务板当成模型多样性、候选独立性和证据验收的替代物。

## 8. 下一轮值得修改与继续争议之处

建议的修改顺序，均仅是研究结果：

1. 先恢复模型差异优先的可执行表述，并区分“跨模型异构”“同模型互补”“同配置重复”。避免将可用性不足悄悄包装成同等收益，也避免因为某个模型不可用就停止所有有价值工作。
2. 拆开 member 与 attempt；规定首次产出、相互阅读后的修订和独立新增观察怎样描述来历。独立性是针对问题和结论暴露的要求，不是对象创建 API 的属性。
3. 将固定状态载体、目录编号、Git 提交拆分、角色模板和通知细节移到运行时/仓库策略；保留可恢复目标、结果指针、决策依据和当前候选这一信息需求。原生任务板缺少决策记录时只补缺口。
4. 以“独立产出 → 按证据取舍 → 续用或新增贡献 → 修订/复核”的可组合行动说明方法，允许跨过任意固定 round。Team 承载协作者和协调，ensemble 承担差异利用与实质判断。
5. 在 DSH 指南中显式区分本会话具名成员工具与 `39163dd` 的 subagent tree，依据实际 schema 写调用示例；不要将 checkout API 当成当前环境可调用事实。

仍应交给 lead 汇总讨论的问题：

- **模型优先写到多强？** 建议采用“关键独立判断默认优先跨模型，未用时说明适任性、授权或成本理由”，而不是所有动作一律至少两种模型；用户是否期待更硬的跨模型最低要求尚未由本轮源码决定。
- **attempt 是否必须独立？** 建议中性定义 + 明示独立属性；若保留严格定义，应为 refinement 留清晰称谓，两者都必须打破 member=attempt。
- **何时值得再开 fresh？** 需要抵抗既有结论锚定或新增模型先验时值得；既定 finding 的修复/重验通常可复用。边界靠具体争议问题，而非统一轮数。
- **最小持久信息放哪里？** Team 的任务完成状态不足以记录候选与验收事实，但不意味着必须继续维护全量双重状态。应根据当前可恢复机制选择少量权威记录与指针，避免先建一套通用账本。
- **怎样验证模型异构性真的有用？** 本轮只建立方法论与工具事实；未来若要声称成本收益，应在同基线、同关键问题下比较跨模型与同模型重复的有效发现，而非比较角色标签数、报告长度或一致率。

## 自审记录

已完成对现行五份 ensemble 文档、三个角色、OMP adapter 与测试、两次关键 Git 提交及所引用 DSH 源码/文档的静态阅读。本文把实际观察、方法推论和假想反例分开，保留当前运行时与固定 checkout 的差异；未声称运行测试或验证模型效果。任务完成只表示本次研究产出已交付，不代表 lead 或用户已接受上述方法修改。
