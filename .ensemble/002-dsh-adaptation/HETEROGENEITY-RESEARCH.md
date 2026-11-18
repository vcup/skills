# 多维异构性与真实思考强度：接续研究

作者：methodology；任务：task-6；日期：2026-11-16（UTC）。只读调研，不实现、不修改旧稿或现行技能。工作区 HEAD 为 `689972f5911aaa0d14f11edaca0990a13443e5c9`，DSH checkout 为 `39163dd30f703a79079e2d2446545cff3c453738`。本次是同一成员在用户反馈后的修订，不是新增独立样本。未联网、运行产品或测试；以下测试文件仅作静态契约证据。

## 1. 修正上轮过强结论

**一般异构性不等于模型异构性。同模型的不同指令、问题视角、知识输入、观察方法、真实工具能力与推理配置，都可能构成有实质作用的异构性；不应一概叫“降级”。** 模型差异仍是重要且不能由任务标签伪造的维度，但没有源码或本轮实验支持把它排成对所有问题都最优的固定优先序。

这不是替当前工具不足找理由。应同时保留两个判断：

- 当前接口不能显式选模型，就没有覆盖用户要求的**模型异构执行能力**；有用的同模型组合不能被拿来声称已经满足这个需求。
- 当前已经能给不同 prompt/方向的协作者分派互补工作，它们仍可以是有效 ensemble；是否缺少某维，应相对当前目标和计划说明，而非给所有同模型工作贴低等级标签。

我上轮 [方法研究](</home/vcup/projects/vcup-skills/.ensemble/002-dsh-adaptation/METHODOLOGY-RESEARCH.md#L52-L67>) 对“关键判断默认跨模型”与共同盲点的强调有合理动机，但将其他维度排在模型差异之后，并与当时的“同模型降级”表达合用，过度收窄了一般异构性。当前 [术语提案](</home/vcup/projects/vcup-skills/.ensemble/002-dsh-adaptation/GLOSSARY.md#L7-L9>) 已改成“同模型组合也可以具有有效异构性”；本文进一步补足依据，旧研究保留以交代修订来历。

**源码/历史观察：** [现行词汇表:25–39](</home/vcup/projects/vcup-skills/skills/ensemble/GLOSSARY.md#L25-L39>) 把 model、role、assignment、knowledge、approach、trade-off、failure model、observation method 都列为异构来源；初版 `88c9063` 的这一定义已经如此。[方法说明:104–132](</home/vcup/projects/vcup-skills/skills/ensemble/README.md#L104-L132>) 又把 same-configuration、cross-model、role-diverse 都列为重复检查的组合，并将快/深/跨模型的选用明确称作 heuristics，非保证。上轮核对出的 `e650367` 删除显式模型优先语句仍是事实，但不能据此推成“其他维度只是次等补丁”。

[方法说明:14–28](</home/vcup/projects/vcup-skills/skills/ensemble/README.md#L14-L28>) 中 assignment “cannot replace model or role diversity”更合适的解释是：**不能把一种差异冒充另一种差异**，而非 assignment 自身不构成异构。现行 [执行契约:21–35](</home/vcup/projects/vcup-skills/skills/ensemble/SKILL.md#L21-L35>) 本来也允许模型、方法、证据来源、failure lens 或明确冗余组成有用贡献。

## 2. 三个不同问题：异构性、独立性、冗余

| 维度 | 它回答的问题 | 不能推出什么 |
|---|---|---|
| 异构性 | 哪些实际差异可能改变产物、观察或判断？ | 差异存在不证明收益，更不保证结果正确 |
| 独立性 | 对当前比较问题，首次形成结果前是否继承了被比较者的结论/论证？ | 新 agent、换模型或 high effort 都不自动独立；这里也不宣称统计独立 |
| 冗余 | 哪个重要贡献或风险镜头值得重复，避免过度依赖一次尝试？ | 重复不要求配置不同；返回次数也不等于新增独立证据 |

三者可以组合，而不是三个互斥等级：

- 同模型、同配置、同镜头且未互相读结论：独立重复；不必虚构已设计的异构维度。
- 同模型、不同 failure lens/方法且先独立产出：有方法异构；若重查同一承重判断，也有冗余。
- 不同模型重复同一契约：同时有模型异构和冗余；仍要控制结论继承。
- 同模型不同 effort：推理配置异构；若后一次已读前次论证，则是接续/检验，不是新的盲评样本。

同模型不同方法可以揭露某些此前遗漏，不能说它**绝不可能**发现模型相关错误；准确限制是它没有引入另一个模型的先验，仍保留共同模型因素。跨模型也只提供另一种先验来源，不保证摆脱共同训练偏差、错误输入或相同锚定。首次独立产出与后续交流的区分，依据 [现行原则:114–124](</home/vcup/projects/vcup-skills/skills/ensemble/README.md#L114-L124>)。

## 3. 哪些差异有意义，哪些说法不是能力保证

| 可组合差异 | 可以影响什么 | 应怎样如实描述 |
|---|---|---|
| 模型/provider 路由 | 模型先验、能力、习惯及盲点来源 | 记录实际路由；不同 provider/别名不证明底层模型不同 |
| prompt、初始指令、failure lens | 搜索方向、反例、假设、取舍与交付要求 | “按撤销/崩溃重入检查”是策略差异；“你是高级专家”本身只是一句身份提示 |
| 共同问题上的不同方法/证据 | 源码追踪、契约推导、测量、测试可产生不同观察 | 给得出可比较结论的任务，不只让各人换标题表达意见 |
| 工具、权限、隔离与真实 preset | 能取得哪些证据、能否执行某类工作、修改能否受约束 | 检查实际装载和执行边界；有工具不等于已使用，更不等于检查已通过 |
| 真实 `reasoning_effort` | provider/model 声明的推理控制选项 | 记录精确路由、请求/实际解析值与适用请求；不是固定算力、正确率或费用等级 |
| 上下文与专业积累 | 已知事实、已有结论、熟悉程度与路径依赖 | 可复用有价值知识；不要把已有答案包装成全新独立发现 |

**prompt 可以指定行为目标，不能单独证明权限、工具、模型或 effort 已改变。** [OMP reviewer 配置](</home/vcup/projects/vcup-skills/agents/ensemble-reviewer.md#L1-L9>) 有 bash，同时正文说“Do not edit files”；这是一条行为要求，不是路径写入隔离证明。三个现有角色文件均未直接声明模型或真实 effort：[scout](</home/vcup/projects/vcup-skills/agents/ensemble-scout.md#L1-L9>)、[worker](</home/vcup/projects/vcup-skills/agents/ensemble-worker.md#L1-L8>)。名字叫 reviewer、deep 或 fast 不能替代实际配置核对。

DSH 的 preset 也是运行时配置入口而非“角色名即能力”的保证：[preset 选择](</home/vcup/projects/deepseek-harness/packages/subagent/tool-subagent/src/preset-selection.ts#L49-L75>) 检查授权列表以及 backend 是否支持独立 preset；仅换 prompt 不会调用这条机制。工具集与权限边界还须核对所选 preset 和底层执行策略，不能只依据上述选择校验推定沙箱保证。

## 4. DSH 的真实 reasoning effort 链路

下述是固定 checkout 的实现事实，不是本会话已经执行成功的声明。本次重新读取实际 `subagent`、`subagent_fork` schema：只有 `cwd/description/prompt`；本会话 `spawn_teammate` 的 schema 为 `name/description/prompt/context`。这些工具当前均未向调用者暴露逐成员 effort 参数。没有尝试往不支持的 schema 塞入参数，也没有通过 prompt 假称切换。

### 4.1 先区分两层 provider 能力

1. **delegation backend 能否承接配置：** `tool-subagent` 的 `modelSelection` 决定是否暴露 `provider/model/reasoning_effort`；配置中也可有 `agentOptions.reasoningEffort`。[工具配置:45–99](</home/vcup/projects/deepseek-harness/packages/subagent/tool-subagent/src/index.ts#L45-L99>)、[挂载检查:168–184](</home/vcup/projects/deepseek-harness/packages/subagent/tool-subagent/src/index.ts#L168-L184>) 要求 backend 的 `capabilities.agentOptions`。service 启动边界仍会 [拒绝 backend 不支持的请求能力](</home/vcup/projects/deepseek-harness/packages/subagent/subagent/src/index.ts#L579-L599>)，不是只有 schema 隐藏。
2. **所选 LLM route 能否接受这个 effort：** `ReasoningEffortId` 是 adapter-owned 的标识。具有这项能力的 exact provider/model 路由声明可选 efforts 和可选默认值；[类型说明:413–431](</home/vcup/projects/deepseek-harness/packages/llm/llm/src/types.ts#L413-L431>) 明言顺序不是预测 token 用量或时延。`agentOptions` 能传入字符串，不等于目标模型支持它。

### 4.2 显式选择必须带路由，省略不等于固定继承

[参数 schema:247–259](</home/vcup/projects/deepseek-harness/packages/subagent/tool-subagent/src/index.ts#L247-L259>) 与 [执行校验:106–156](</home/vcup/projects/deepseek-harness/packages/subagent/tool-subagent/src/model-selection.ts#L106-L156>) 的精确规则是：

| 调用形态 | checkout 语义 |
|---|---|
| 显式 `reasoning_effort`，不带 provider/model | 拒绝；即使配置中有默认路由，也不能只传 effort |
| 显式 provider/model + effort | 要求工具允许选型、路由获准，再校验该模型支持的 effort |
| 显式 provider/model，省略 effort | 清除兼容的父/config effort，改用所选模型默认；即使路由与父路由相同也如此 |
| 三个字段都省略 | 使用工具配置和父当前请求配置的合并规则；不是上述“显式选路取默认”的同义调用 |

没有 Session 选型 policy 时，显式路由限制为当前父路由，并非禁止该路由上的一切 effort 选择；[测试:229–244](</home/vcup/projects/deepseek-harness/packages/subagent/tool-subagent/tests/model-selection.spec.ts#L229-L244>) 对同路由 `low` 的接受作了断言。这里是静态读到的测试意图，未运行。当前实际工具没有字段，不能把 checkout 这个能力直接写成当前可用。

这项省略语义来自历史修正 `5a75c8b4a5b7b40f550212a22d6111cbd3272255`（`require an explicit route for reasoning overrides`）；已读其 diff，旧的 effort-only 用法不适用于此 checkout。父子合并另见 [child-agent:60–117](</home/vcup/projects/deepseek-harness/packages/subagent/subagent/src/child-agent.ts#L60-L117>)：默认读取父最新请求的路由/effort；换路由且未指定 effort 时不把父路由的值硬套过去。

### 4.3 发现、预检和真实请求不是同一层证据

- [模型发现:88–96](</home/vcup/projects/deepseek-harness/packages/subagent/tool-subagent/src/list-models.ts#L88-L96>) 对已授权的 exact route 返回其 advertised efforts/default；没有广告值不等于可以猜一个 `high`。
- [工具执行:282–337](</home/vcup/projects/deepseek-harness/packages/subagent/tool-subagent/src/index.ts#L282-L337>) 在显式选择或配置含 LLM 选择时，先调用 [预检函数](</home/vcup/projects/deepseek-harness/packages/subagent/tool-subagent/src/model-selection.ts#L159-L200>)，再创建 activation。无显式选择且无相关配置的继承路径不总走该创建前预检；不能宣称所有入口都先经过同一套 tool policy。
- [LLM runtime:903–955](</home/vcup/projects/deepseek-harness/packages/llm/llm/src/index.ts#L903-L955>) 解析模型能力和默认值；不支持显式 effort 时抛出 `UNSUPPORTED_REASONING_EFFORT`，不静默 clamp/改名。预检不绑定之后实际请求；[prepareCall:963–1022](</home/vcup/projects/deepseek-harness/packages/llm/llm/src/index.ts#L963-L1022>) 才把一次请求的 adapter 注册、已解析配置和 dispatch 绑定。
- 具体 provider wire mapping 各不相同。例如 [DeepSeek 序列化:147–156](</home/vcup/projects/deepseek-harness/packages/llm/llm-deepseek/src/serialize.ts#L147-L156>) 将 effort 转成 `thinking.type` 和 `output_config.effort`；[pi-ai 解析:191–225](</home/vcup/projects/deepseek-harness/packages/llm/llm-pi-ai/src/adapter.ts#L191-L225>) 另按模型 metadata 校验，并且没有真实可选 reasoning 能力时不伪造 `off` 开关。

因此可以证明“按这条路由请求了一个受支持的控制值”，不能仅由配置名证明“模型实际多想了 N 秒／用了 N token／结果更正确”。“请深入思考”则只改变消息中的指令；即便结果变长，也不是上述控制链已经触发的证据。

### 4.4 持久化要分创建声明、后续选择与实际请求

[manager:340–350](</home/vcup/projects/deepseek-harness/packages/subagent/subagent/src/manager.ts#L340-L350>) 把创建时合并的 `agentProvider/agentModel/agentReasoningEffort` 放入 descriptor；[cold resume:1244–1258](</home/vcup/projects/deepseek-harness/packages/subagent/subagent/src/manager.ts#L1244-L1258>) 用这些值重建子 Agent 选项，而不是读取 Lead 此刻的新选择。[continuation 测试:3932–3967](</home/vcup/projects/deepseek-harness/packages/subagent/subagent/tests/continuation.spec.ts#L3932-L3967>) 静态断言了显式 effort 的恢复与请求记录。

但 **descriptor 不是“该成员此后永远使用这一 effort”的事实库**。[AgentModel:73–120](</home/vcup/projects/deepseek-harness/packages/core/agent/src/model-selection.ts#L73-L120>) 优先读取该 Session 的 pending/lastUsed 选择，创建 options 只是 fallback；后续选择会记录 `model/selection`。[Agent loop:650–685](</home/vcup/projects/deepseek-harness/packages/core/agent-loop/src/agent.ts#L650-L685>) 记录经解析的 `request/header.config` 和 `adapterDefaults`。由 adapter 补出的默认 effort 不会永久冒充显式选择，[selectionOfHeader:14–17,58–60](</home/vcup/projects/deepseek-harness/packages/core/agent/src/model-selection.ts#L14-L60>) 会保留“默认值随后重新解析”的语义。

对研究/看板的推论：能够读到真实请求配置时，以相应请求为依据；只有创建选项时标成“创建配置”，只有 prompt 时标成“任务指令”。不因一次成功创建、恢复或一句“deep reviewer”而断言所有尝试一直使用某个 effort。无需为此先造新的持久化账本。

## 5. 三个组合场景：从问题与成本推导，而非打分

### A. 可直接验证的并发缺陷：同模型方法异构可能更切题

一个适任模型的 A 从锁/所有权不变量推导非法状态，B 在相同基线下设计重入与取消调度的复现；首轮不互读答案，使用实际获准的不同观察手段。它们共享模型但在方法/证据上异构，不应仅因同模型叫降级。若剩余不确定性是共同建模前提，再加入另一适任模型做针对性挑战。多模型但都只复述同一抽象说明，未必比这里多出有用证据。

成本判断：先选能直接区分假设的检查；复用已有复现继续修复/重验可省去重建知识，但不得把续聊计成新独立样本。不因有额外模型额度就创建无明确用途的参与者。此为设计推导，不是本轮性能比较。

### B. 难直接验证的协议设计：保留模型异构，再叠加推理配置与镜头

两种适任模型从共同需求独立提出故障与恢复模型，分别做不变量推导和操作场景检查；重大分歧再要求可区分方案的原型/反例。如果其中一个角色需要更强推理配置，可在其 exact route 的真实受支持 effort 中选择，不能要求它“扮演另一个模型”来替代跨模型需求。

若当前 Team 接口没有选模型/effort，该能力缺口真实存在，值得研究插件或上游接入；prompt 的“深思”只能作为可立即采用的策略差异，并不关闭该缺口。是否付出跨模型和高 effort 的成本，要看难度、错误后果、工具适任性与可取得的证据；effort 名称不提供跨 provider 的统一成本比较。

### C. 大范围表面摸排后核对一个高风险判断：深度、广度与重复各有位置

同模型不同区域/失败镜头先找边界，针对真正承重的问题再安排独立重查：可用相同配置重复以防一次性遗漏，也可在授权接口允许时增加不同 effort/另一模型。重复同一 concern 可以同时具有配置异构；仅把文件分成几堆、结果没有互补或可核对作用，则只是普通分工，并不因人数多而成立 ensemble。

若 deep 角色在实际配置中与其他角色完全一致，应该记录为不同指令而非强度差异；若同一成员读完首轮报告后切换到 high，则是带历史的精化，不是盲评。选择先广后深、直接深查或增加一个异模型，取决于哪一步还可能改变决定，不设“异构性分数”、固定人口或固定轮数。

## 6. 建议措辞与执行接入边界

建议替换上一轮过强概括为：

> Ensemble 有意识地组合能改变结果的差异：模型、指令、任务视角、知识与证据来源、工具/能力、观察方法及受支持的推理配置。按问题、风险、成本与适任性选择；关键判断应显式考虑模型差异，但不把同模型组合自动视为降级，也不把其他维度冒充跨模型。先独立形成需要比较的结果，再按事实取舍和修订；同配置独立重复可用于降低对一次尝试的依赖。

> 当计划确实需要跨模型或真实 effort 控制，而当前接口不能表达，应明确记录该能力缺口并研究接入。提示词中的模型名、角色名或深思指令不替代实际路由与 provider 参数，也不构成工具权限、隔离或验收保证。

给 execution 调研的边界输入仅限需求，不预断其接入方案：理想的配置入口应区分 delegation backend、LLM route、真实 effort、prompt/preset；能发现或验证目标能力、拒绝不支持组合，并保留声明配置与实际请求的区别。是否需要在旧具名 Team 核心加字段或通过插件复用原生机制，由该成员的版本源码调查决定，本研究不借 checkout 的普通 subagent 能力宣称当前 teammate 已能选型。

## 自审与可复核性

已读回核对本文，修正了旧措辞引用与 reasoning 能力可选性的表述。关键历史复核命令如下；本轮未运行产品或测试。以上“测试断言”均指实际读到的测试源码，不指本轮运行结果。我仅新增本文件，未修改此前研究与设计，由 Lead 处理综合稿中的结论修订。

```sh
git show 88c9063:skills/ensemble/GLOSSARY.md
git show 5a75c8b4a5 -- packages/subagent/tool-subagent/src/model-selection.ts
git rev-parse HEAD
```
