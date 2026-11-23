# 原生代理、上下文与模型选择

本设计的源码基线是 DSH **`0.2.2-rc.4`**，固定提交 **`3f321d32bfe382212a8ed8785c1d47a5a300aa23`**；对应正式标签 `dsh-v0.2.2-rc.4`，已核对[包清单][version]及[发布基线](README.md)。该固定提交是设计依据，不是当前支持范围：受测集合与默认版本见[版本支持与升级](../UPGRADING.md)。源码支持、部署配置和实际运行结果分别取证；当前会话的旧工具 schema 不作为目标版本能力上限。通用方法和场景取舍见[驱动选择指引](../../skills/ensemble/README.md#choose-how-to-drive-native-agents)，本文件负责 DSH 接入决定。

## 1. 一个代理模型，分别选择上下文与协作方式

Member 是参与 ensemble 的原生代理，不增加 teammate 类型。目标 Team 复用原生子代理树，仅增加可选共享任务板。fresh、fork 与续用决定信息来源和交接方式；是否有消息、任务、工具和档案权限另行核验。

| 工作需要 | 原生入口 | 需要保留的区别 |
|---|---|---|
| 自足问题、独立首轮、窄范围快速查证 | `subagent`，本地 spawn | 新上下文减少无关历史；任务包、共享文件和消息仍可能暴露答案 |
| 分支继续已有调查 | `subagent_fork`，本地 fork | 继承已完成轮次；当前轮新增要求须写入 prompt。继承答案后不能冒充独立评估 |
| 追问、指导修复、再次应用方法 | 对原生身份 `send_message` | 本地 fresh/fork 都可续做；首轮返回不等于代理身份消失，指导修订不增加独立样本 |
| 很多独立项、流水线、结构化汇总与程序控制的并发 | `workflow` 的 `agent`、`pipeline`、`parallel` | 适合批量编排；脚本返回结果与原生驻留成员的消息驱动是不同的调用方式，不能仅为选模型就强制所有工作使用 workflow |

模型、上下文方式与编排方式分别选择。快速模型适合有明确证据入口的查证；复杂取舍需按适任性选型。fresh 并不保证更快，fork 也不使继承 token 免费：交接重建、历史长度和前缀缓存共同影响成本。需要持续教学、同级沟通或共享任务时，优先确认所选 backend 的 continuation 和工具能力，而不是由 `subagent`/`teammate` 名称判断。[spawn][spawn]、[fork][fork]、[workflow 执行][workflow-host]。

## 2. 通信与共享任务的具体答案

**目标版本普通子代理可以互相通信。** `list_agents` 展示 root、自身及所有可达 continuable 后代；`send_message({agent,message})` 使用完整树内名称，也接受合法 Session id。live root 或 resident continuable 成员可联系同树父、子、同级及其它分支；拒绝自身、无关树或不支持的目标。消息受理只表示进入 inbox，不代表收到答复、完成工作或持久保存成功。它不依赖 Team 开关；interrupt 则有单独的祖先权限和工具开关。[控制工具][control]、[消息执行器][messages]。

**普通子代理也可以读、创建和领取共享任务，条件是根 Session 开启 Team 且工具可用。** 子代理使用 live root 的 mode 和任务板，不因 fresh/fork 分成不同 Team。`team_task_list/get` 读取，`team_task_update(action:"claim", expected_revision:...)` 自领未占用且依赖已完成的任务；普通修改由 owner 或 root 执行，重派由 root 执行。任务变化和 owner 分配不自动启动代理，也不结束 inbox wait；需要对方行动时发送消息。write scopes 是提示，不是文件锁，原生任务 owner 也不授予 archive grant。[Team][team]、[任务执行器][tasks]。

创建 fresh 成员并参与共享任务是正常原生路径，不是需要额外模拟的特例。Lead 可先创建任务再为它创建合适的 fresh `subagent`，也可先创建有明确调查产物的成员，再据结果分派后续任务；不要求先耗尽已有成员。启动任务包给出目标、任务 id、基线和资料引用，成员读取当前 task、相关依赖与必要证据，再核对适配性，按当前 owner/revision 领取未占用任务或接续已分派工作；已有成员也须重新读取，不能把保留旧对话等同于理解新任务。所有必要资料应可授权完整读回，但共享任务可访问不表示整板内容已自动注入，更不要求首轮读取其它成员答案。已占用任务通过原生 release/reassign 交接并发送消息，创建新成员不会自动抢占 owner。按任务与上下文的匹配选择续用、fresh 或协同组合，选择依据见[方法指引](../../skills/ensemble/README.md#choose-how-to-drive-native-agents)。

Team 关闭时，明确分派、原生消息和结果仍可构成 ensemble；不能伪称已经获得共享任务所有权。共享任务成为任务要求时，则要启用并验证该能力，不能悄悄降级。普通 Session fork 创建独立 root，与 `subagent_fork` 的子代理分支不同。

## 3. 模型选择优先通过原生配置开放

**完整 DSH 适配通过 fresh `subagent` 提供获准的 provider/model/思考等级选择，不能仅继承默认模型。** 目标 `@deepseek-ai/dsh-tool-subagent` 已有 `modelSelection` 配置；开启后向 schema 加入可选 `provider`、`model`、`reasoning_effort`，执行器仍验证参数、Session 路由和实际 LLM Adapter。标准 Web spawn 已开启 `modelSelection` 和 `modelDiscovery`。Team 成员同样由此创建，无需另一套选型工具。[工具配置与执行][selection-tool]、[标准组合][standard]。

需要补齐其它 profile 时，修改**已有 spawn 工具实例的 config**，不要在同一作用域再注册同名工具：

```yaml
provider: spawn             # 执行 backend，不是 LLM provider
toolName: subagent
modelSelection: true
modelDiscovery: true
```

实际 Loader patch 必须匹配所选 preset 的实例路径；此处只展示配置字段，不是可直接套用任意 profile 的完整 patch。`modelDiscovery: true` 每个工具作用域仅保留一个 owner，通常放在 spawn 实例；发现开关与选择开关独立。`subagent_fork` 保持标准配置的模型覆盖关闭。

调用示意中 provider/model 来自用户环境的真实路由，不写入可移植配置：

```js
subagent({
  description: "核查消息授权",
  prompt: "按指定版本追踪调用链，给源码依据与反例。",
  provider: "<获准的 LLM provider id>",
  model: "<该 provider 的 model id>"
})
```

使用 `list_subagent_models` 发现当前允许路由和 effort，但目录成员资格不代替实际 Adapter 预检。只有 schema 开关还不够：用户配置的精确路由授权在新 root 创建时记录、由 children 继承并在恢复时保留；之后改设置不回溯旧 Session。没有记录的策略时，显式选择只允许父代理当前有效 route。安装 ensemble 不扩权、不静默开启用户策略。[选择与授权][selection]。

必须保留原生语义：provider/model 同次成对；显式 effort 要求该对字段；全省略保持受信默认/继承；显式 route 省略 effort 清除继承 effort，即使 route 未变也使用所选模型默认值。backend 必须声明 `agentOptions` 支持；不能只给不支持的外部 backend 加参数。

这些参数选择的是**新代理**的模型。`send_message` 没有模型参数，不承诺续聊时原地换模。需要其它模型时，用 fresh `subagent` 加可审任务包与证据引用交接，保留新身份和已暴露信息；不能把复制整段旧对话当成无损换模。

### Fork 保持路由；思考等级调整另作受约束设计

源码允许 fork 实例开启选型，但这只是能力事实，不是 ensemble 的启用决定。**默认不开放 fork 的 provider/model 覆盖。** 不同模型对思考记录、签名块及消息内容的接受与重放语义可能不同；创建成功或有相同文本历史不能证明思考和上下文无损。跨模型异构性通过 fresh 代理实现，按[异构性说明](../../skills/ensemble/README.md#sources-of-heterogeneity)选择模型、方法、指令、观察角度和必要冗余。[源码支持范围][fork-selection-test]。

P0决定本次交付保持fork原有effort，不提供专用调整入口，差异化effort使用fresh代理。若后续扩展同路由fork effort，需明确：读取父代理实际有效等级与该路由能力，给出目标等级、上调/下调的方向及任务理由；未知原等级或没有可靠顺序时报告无法判断，不按字符串排序，也不假定“默认”等于中档。上调可用于更困难的判断，下调可用于已分解的简单工作，均需根据实际产物复核。改变 effort 是一种异构性，不自动提高质量或形成独立样本。

原生工具的 effort 字段要求同时提供 provider/model，单开 `modelSelection` 会一并开放路由参数，因此不能仅靠 prompt 约定“不要改模型”。若提供受限 effort Interface，执行器须从可信父请求派生并锁定原路由，只接受该路由支持的目标等级，保留原生授权与 Adapter 校验，测试并发路由变化及恢复；不得把任意模型输入写入受信 defaults。无法满足时保持原等级，或使用选型明确的 fresh 代理。

## 4. 是否需要包装或覆盖原生工具

优先级如下；仅在前一方案不能满足实际部署时采用后一方案。

1. **配置已有原生实例。** 开启 spawn 的 `modelSelection`，保留一个 discovery owner，明确 Session allowlist；fork 保持路由覆盖关闭。此方案不增加工具或执行层，是目标版本的默认决定。
2. **以独立名称挂载同一个原生插件。** 无法修改原组合但允许扩展 preset 时，可配置额外的选型实例，复用原生执行器。需检查工具预算、深度、preset 及子代理继承；不要同时暴露语义相同的多套默认入口。
3. **作用域内同名覆盖。** 目标 tools registry 允许近作用域覆盖远作用域；同一层重复注册会报错。真正必要时可在 ensemble 专用 preset/agent scope 使用受支持注册与 disposal，复用完整原生实现，验证 schema、执行、日志、输出、生命周期、继承和卸载。不要通过加载顺序猜测“后注册覆盖”。[注册规则][registry]。

**只扩展 schema 的薄包装不够。** 未开启选型的原生执行器仍会拒绝 route 字段；将模型提供的参数转写成受信 `config.agentOptions` 后再调用底层运行时，会丢失模型请求应经过的 Session 策略语义。也不能在同名包装内部按当前工具名递归调用自己。若必须自定义 Adapter，应明确能力缺口并保持真实 caller、授权、取消、深度、原生身份/返回和清理；不能借包装建立新 roster、LLM loop 或伪造模型选择。[执行校验][selection]。

DSH `0.2.2-rc.4` 的该源码基线没有需要另外改造的 `spawn_teammate`：参与 Team 的成员由原生子代理入口创建，使用 fresh `subagent` 的 provider/model/effort 字段已足够满足其选型需求；fork 成员保持原路由。旧具名 Team 桥不纳入本目标。

## 5. Workflow 的位置与验收

目标 workflow `agent(prompt, {provider, model})` 支持独立覆盖两个字段；当前 options 闭集没有 `reasoning_effort`。它经原生 `startActivation` 传递 `agentOptions`，但没有经过 tool-subagent 的同一套模型选择入口，不能未经验证就宣称两者具有相同 Session allowlist 及 effort 语义。不得把 workflow 当作绕过被拒绝选型的通道；相关能力缺口需明确配置、补充受支持 Adapter 或上游改动，并重新验收。[workflow host][workflow-host]、[options 与结果][workflow-runtime]。

P1/P3 验收至少覆盖：spawn 的显式 route/默认/effort、未授权 route 拒绝、fork 保持原路由并拒绝换模、返回身份对应的 actual request、同级消息、首轮后的续做、Team 开/关与任务 CAS、fork 当前轮输入缺失、冷恢复，以及包装方案采用时的遮蔽/递归/卸载反例。同路由 fork effort 方案若纳入，另验上调/下调及未知基线、路由锁定和重放兼容。Workflow 另验模型覆盖、失败子项返回 `null` 与整项成功的区别，以及共享授权规则；不得只凭 requested route 或脚本正常结束证明指定模型已完成工作。源码与既有测试是设计依据，本轮未运行目标 DSH 的这些验收。

[version]: https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/package.json#L1-L4
[spawn]: https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/subagent/subagent-spawn-in-process/src/index.ts
[fork]: https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/subagent/subagent-fork-in-process/src/index.ts
[control]: https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/subagent/tool-subagent-control/README.md#L45-L60
[messages]: https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/subagent/subagent/src/manager.ts#L567-L618
[team]: https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/team/agent-team/README.md#L73-L87
[tasks]: https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/team/agent-team/src/task-board.ts#L128-L201
[selection-tool]: https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/subagent/tool-subagent/src/index.ts#L241-L329
[standard]: https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/bundle/web-app/presets/standard.patch.yml#L89-L116
[fork-selection-test]: https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/subagent/tool-subagent/tests/model-selection.spec.ts#L543-L576
[selection]: https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/subagent/tool-subagent/src/model-selection.ts#L101-L192
[registry]: https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/core/tools/src/index.ts#L121-L152
[workflow-host]: https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/workflow/workflow-ptc/src/host.ts#L200-L241
[workflow-runtime]: https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/workflow/workflow-ptc/src/runtime.ts#L168-L270
