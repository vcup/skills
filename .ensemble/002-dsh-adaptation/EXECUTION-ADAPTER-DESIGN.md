# Ensemble 执行适配：仅面向新版 DSH

本设计固定到 `39163dd30f703a79079e2d2446545cff3c453738`，基线与拉取结果见[源码基线](<UPSTREAM-BASELINE.md>)。**v1 直接使用新版原生工具与设置，不实现 `ensemble_spawn`、执行 provider、选型路由器或 Team bridge。** 本文件定义方法如何消费这些能力；专用 Host/Client 代码见[插件实现设计](<PLUGIN-IMPLEMENTATION-DESIGN.md>)。所有运行验收仍待实施。

## 1. 方法与原生能力的对应

| 方法操作 | 新版 Interface | 方法层的责任 |
|---|---|---|
| 获得另一份初始贡献 | `subagent({description,prompt,name?,cwd?,provider?,model?,reasoning_effort?,agent_preset?})`；字段随配置呈现 | 给中性问题、共同事实、输入基线、产物与完成条件；fresh 不等于安全隔离或不同模型 |
| 明确继承父上下文 | `subagent_fork`；标准组合未开启其选型字段 | 检查继承的信息是否含待比较结论；fork 是会话上下文复制，不是文件隔离 |
| 继续有价值的既有工作 | `send_message({agent,message})` | 使用创建返回或发现到的完整 catalog name；续聊、修订不重复计作独立样本 |
| 找成员与等结果 | `list_agents`、`wait_agent` | inactive 只表示无 turn；wait 等调用者 inbox，不等共享任务变更；多层后代需明确汇报路径 |
| 持续协作 | 根 Session 开启 Team 后的 `team_task_*` | 读取最新 revision 后 claim/update，安排依赖与写范围；任务 ready/owner 变化不启动成员，需另行发消息 |
| 停止工作 | 仅在组合启用时使用原生 `interrupt_agent` | 标准 preset 默认不暴露；请求受理不等于已停，且不递归停止后代；竞争写 owner 不能提前转交 |

创建 local continuable child 已进入原生 subagent catalog；Team 使用同一棵树的根任务板，不拥有另一类成员。返回名字与 ensemble Attempt 不是同一个概念。完整 schema、生命周期和固定源码依据见[新版执行复核](<NEW-DSH-EXECUTION-RESEARCH.md#L13-L25>)。

异构性、冗余与独立性分别判断。同模型的源码契约追踪、反例搜索、用户路径测试可以有实质差异；如果特定判断需要检验共同模型盲点，则使用获准且适任的不同模型。角色名、prompt 中的模型名和“深入思考”都不改变底层配置。

## 2. 最小支持组合与启用条件

第一版支持目标是该源码基线的标准 Web 组合，以及装有同等原生服务的 headless 组合；其他 preset 必须通过自己的组合验收，不宣称自动适配所有部署。

- 标准 `subagent` 已启用 `modelSelection`、`modelDiscovery`；不另建同名工具，也不覆盖整个 delegation 组。
- 标准 `subagent_fork` 未启用选型，control 配置为 `interrupt:false`。只有明确需要时才提供对已有行的示例配置；执行授权和控制仍由原生插件承担。
- 原生配置 patch 替换整个目标 config，不是任意深度合并。示例应保留该行需要的完整配置，实施时核对实际组合，不能误删已有键。
- 模型发现与显式选择是两个开关；同一 scope 只保留一个 discovery owner。允许的 preset 必须真实安装并列入原生 allowlist，不预造固定 reviewer/implementer id。
- Team 默认关闭，任务工具只在根 mode enabled 且 root 可用时呈现。通过现有用户设置/入口启用；不虚构模型可调用的 enable 工具。Team 关闭不停止成员、不清除任务。
- 模型路由授权通过原生设置为新根 Session 记录，children 继承。设置变化不回溯修改旧 Session；安装 ensemble 不授权任何额外模型。
- 创建与冷恢复服从原生深度、活动容量和权限限制；容量满时等待、复用或缩小并发，不另造排队器绕限制。

依据：[标准组合](<../../.scratch/extra-src/deepseek-harness/packages/bundle/web-app/presets/standard.patch.yml#L89-L116>)；[完整启用条件与来源](<NEW-DSH-EXECUTION-RESEARCH.md#L29-L61>)。

## 3. 选型与省略语义

`tool-subagent` 配置中的 `provider: spawn/fork` 指执行 backend；模型调用里的 `provider/model` 指 LLM 路由，不能混用。

| 输入 | 原生行为与指引 |
|---|---|
| provider/model/effort 全省略 | 保留原生受信配置默认与父配置继承；不能描述成总是继承父 route |
| 显式 provider + model，effort 省略 | 清除继承/配置 effort，采用所选 route 的默认值；即使选回相同 route 也如此 |
| 显式 reasoning_effort | 同次调用必须同时给 provider + model；使用 exact-model 支持值，不假定所有模型都有同一组 low/high |
| 半对 route 或 effort-only | 明确拒绝，不由插件猜另半项 |
| 无 Session policy | 在工具已开放选型时，显式 route 仅能选父当前 route；该 route 支持的 effort 仍可选择 |
| 有 Session policy | 显式 route 必须命中精确允许列表；不能自动把父 route 额外加入 |
| trusted `agentOptions` 默认 | 属于部署者配置，不是模型显式选择；不得把模型输入塞进 defaults 绕过授权 |
| 独立 agent_preset | 本地 spawn 支持允许列表内选择；fork 拒绝独立 preset，含与父同名的显式选择 |

模型发现是能力信息，不是调用成功证据。已允许但未 advertised 的 exact model 仍可查询其能力；创建预检失败应显式报告，不静默回退。真实 effort 是 route 控制设置，不代表实际算力或质量，也不能用答案长度来验证。

原生 `startActivation` 管理生命周期，**不自动执行工具层的模型选择策略**。v1 使用原生工具，因而不复制其内部 selection helper，也不从 `src/*` 机械导出构造私有公共依赖。没有当前消费需求，不提前提取公共选型 Module。[选型矩阵与源码](<NEW-DSH-EXECUTION-RESEARCH.md#L38-L54>)

## 4. 上下文、记录与恢复

创建前，在现有贡献描述中简记问题、基线、实质差异或重复理由、初始信息来源；不增加模型配置文件或规定机器标签。比较首轮不分发 sibling 论证；首轮完成后可以交流、修订、续聊。共享文件和任务板可能暴露已有结论，fresh 也不能自动保证盲评。

区分三种证据：

1. **请求选择**：工具实参说明想选择什么。
2. **创建记录**：child descriptor 说明声明/继承后的配置；未填写默认 effort 不等于已知实际值。
3. **实际请求**：原生 child `request/header.config` 才是对应请求所用 route/effort 的依据。

`list_agents` 在本基线不返回模型或 effort，不能据此给看板加“已验证跨模型”标记。协调者能核对请求记录时附证据；没有访问入口或未核对时写“请求配置，未核对实际请求”，而不是编造已应用状态。普通 Markdown 中未记录的信息保持未知。

原生 cold resume 恢复 child 已保存的模型/显式 effort 和 preset 事实，不改为 Lead 当前模型；preset 使用当前注册定义，不保证跨重启逐位相同执行环境。恢复重要结果时仍需读产物、核对候选和过期检查。消息接受、成员完成、任务 completed、贡献采纳与交付验收分别判断。[身份与恢复来源](<NEW-DSH-EXECUTION-RESEARCH.md#L63-L74>)

v1 不支持对既有成员热换模型，不接管成员 shutdown，不创建自己的恢复数据库。卸载 ensemble 只撤销其技能、工具与视图，不杀死原生成员；根 Session 关闭和原生任务生命周期仍由 DSH 管理。

## 5. 方法执行的一个完整切片

1. 协调者澄清交付目标、当前候选和重要不确定性；先记录既有 Markdown 检查点。
2. 选取有用的差异或重复观察：例如两个模型分别判断同一核心方案，或同模型分别追踪协议与搜索反例；不固定人数以外的角色流水线或代数。
3. 查看实际工具与获准路由，必要时由用户在原生设置中授权并开启适用的新根会话；不能授权的差异记为未满足，不伪装成成功。
4. 并行发出中性初始任务包；已启用 Team 时领取/分配工作项并显式唤起。共享写入拆分范围；竞争实现另备隔离基线，`cwd` 选项本身不复制文件。
5. 依据源码、测试、测量、反例或需求取舍贡献；有价值的作者继续修订，必要时增加新的独立观察。
6. 协调者整合一个可识别候选并验证；更新采纳理由、实际检查、未满足条件和下一步。看板仅整理这个记录，不参与执行。

Coordinator 可以亲自调查、实现与验证。是否继续增加成员取决于能否改变结果或重要判断，而非追求票数和全员一致。

## 6. 实施验收

完整细分场景见[研究中的验收矩阵](<NEW-DSH-EXECUTION-RESEARCH.md#L90-L100>)。交付至少需要以下不同证据，不能相互替代：

- **Loader 真实组合 + keyless snapshot**：工具 schema、用户技能策略、Team off/on、发现 owner、scope 限制均正确；不是只有手造 Context 单测。
- **授权和省略矩阵**：未授权 route、半对参数、effort-only、不支持的 effort、fork + preset 明确失败；显式同 route 清 effort、全省略继承得到区分。
- **原生成员连续性**：创建、消息、任务 CAS、重名、容量、取消受理、冷恢复分别验收；Lead 改模型不污染成员事实，关闭 Team 不冒充停止成员。
- **真实 Adapter smoke**：两个获准模型的实际请求，以及同模型不同受支持 effort 的请求记录。无凭证或缺可用 route 时标记未验证，不能靠 mock 宣称模型差异已经生效。
- **方法有效性**：同模型方法差异正常被记录；fresh/fork/续聊的信息来源可辨；任务完成不自动采纳，集成候选另行验证。

旧具名 Team 的历史研究保留供追溯，但不进入本设计的实现任务、兼容分支或验收范围。
