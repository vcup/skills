# 子代理模型/provider/effort 选择：Flash 定向源码核验

> **历史定向研究：`39163dd` 开发快照。** 原报告标题中的“DSH 0.2.2-rc.3”指包版本，不代表正式 rc.3 发布。固定源码为 `39163dd30f703a79079e2d2446545cff3c453738`；现行接入基线是正式 rc.4 `3f321d32bfe382212a8ed8785c1d47a5a300aa23`，见[发布基线](<RC4-BASELINE.md>)。本文保留原始 11 条判断及 Lead 更正，必须合读；结论 1、2、7、8 受后文限制，错误码也不能直接当成 rc.4 契约。现行决定以[原生代理接入](<../NATIVE-AGENTS.md>)和[实施准备](<../IMPLEMENTATION.md#2-原生执行选择保持原生>)为准。

原调查通过 workflow 请求 Flash 路由后返回以下报告；部署 provider id 不属于可移植研究内容，且未另采集实际 LLM request，因此不能把所请求模型当成独立核实的实际模型。任务已提供 fork 保持路由的用户决定，属于定向核验，不计作独立盲评。原报告下方的 Lead 复核对过强表述作出明确处分。

仅读固定 SHA 下的 4 段源码，未运行任何命令。

## 原报告结论（11 条，须与 Lead 更正合读）

1. fresh subagent 默认**不能**选 provider/model/effort：`modelSelection` 配置项默认 `false`，此时子工具 schema 不暴露 `provider`/`model`/`reasoning_effort` 三个可选字段。
2. 三个字段一旦暴露，`provider`+`model` 必须成对提供；`reasoning_effort` 单独给会被拒，必须与两者同时给或三者全省。
3. 开启条件：该 tool 实例 `modelSelection: true`，且所委托 provider 支持 `agentOptions`；`modelDiscovery`（默认 false，每 scope 仅一个实例）只注册 `list_subagent_models` 发现工具，**不**开启选择。
4. 执行期校验一：未开启却传字段 → `SubagentError('child model selection is disabled for this tool instance', MODEL_SELECTION_DISABLED)`；字段为空/不成对 → `ToolArgsError`。
5. 执行期校验二：`assertAllowedModelSelection` 按 Session 策略白名单放行；**无策略时只允许父级当前 provider/model 本身**，其它路由 → `MODEL_ROUTE_NOT_ALLOWED`。
6. 执行期校验三：存在模型请求或已配置 LLM 选择时做路由 preflight（需 `llm` 服务），并在启动前复查 provider 未被替换，否则 `PROVIDER_CHANGED`。
7. effort 不在路由白名单内：白名单只比对 provider/model，因此"同路由升降 effort"是该机制下唯一可单独放开的维度（仅作为以后受限设计，不在本次开放）。
8. 同名覆盖允许范围：仅允许**作用域工具遮蔽全局工具**（scoped shadow global）；同一层内重名注册直接失败；`run_code` 为保留名，禁止注册或遮蔽。
9. 仅改 schema 不足：字段可见性只是模型侧呈现，真正决定权在执行路径（`requestedAgentOptions` + `assertAllowedModelSelection` + preflight），直接/替代调用者可绕过 schema。
10. 仅改 schema 也拿不到策略：允许集来自 Session 投影（`subagentModelSelectionPolicy`），缺策略即锁死父路由，schema 放开也不会生效。
11. 本次决策维持：fork 保持父级模型与 provider，不默认开放换模；effort 升降至多留作后续受限设计，不建议开启 fork 换模。

## 4 段源码引用

1. [工具 Config](<https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent/src/index.ts#L45-L87>)：`provider` 必填；`modelSelection?`（默认 false）才暴露子级 `provider`/`model`/`reasoning_effort`，并要求 provider `agentOptions` 支持，执行受 Session 策略或父路由限制；`modelDiscovery?`（默认 false，每 scope 一个实例，不开启选择）；`agentOptions`、`maxDepth` 子级默认值。
2. [工具 execute](<https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent/src/index.ts#L275-L329>)：要求调用方 agent；读取 `subagentModelSelectionPolicy(...parent.session)`；`requestedAgentOptions(...)` 合并配置/请求/父选项；`requiresRoutePreflight` 时取 `llm` 服务并 `preflightChildLlmRoute`，再校验 provider 未变更（`PROVIDER_CHANGED`）；随后解析 `maxDepth` 并组装请求（`agentOptions` 仅在非 undefined 时传入）。
3. [模型选择校验](<https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent/src/model-selection.ts#L106-L156>)：`requestedAgentOptions` 无请求直接返回配置；`enabled=false` → `MODEL_SELECTION_DISABLED`；`provider`/`model` 必须成对，`reasoning_effort` 需两者同时存在；`assertAllowedModelSelection` 无策略时只允许 `provider === parentOptions.provider && model === parentOptions.model`，有策略时按 `policy.routes` 匹配，否则 `MODEL_ROUTE_NOT_ALLOWED`；effort 显式 undefined 会清掉继承的父 effort。
4. [工具 register](<https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/core/tools/src/index.ts#L120-L152>)：作用域工具遮蔽全局工具，同一层内重复注册与保留名 `run_code` 失败；返回精确的注销 disposer。

## Lead 复核与处分

- 结论 1 只说明插件默认，不能说标准 Web 的 fresh subagent 默认不可选。其 spawn 实例明确开启两个开关：[标准组合](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/bundle/web-app/presets/standard.patch.yml#L99-L110)。
- 结论 2 不应读成必须同时提供全部三个字段：provider/model 成对即可，effort 可省略，此时显式 route 清除继承 effort；全省略是另一种保持默认的请求。[参数校验](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent/src/model-selection.ts#L106-L156)。
- 结论 7 的“唯一可单独放开”不由所读代码推出，不采纳该量词。路由白名单只比较两个字段，但模型能力仍验证 effort；可选 fork effort 的原路由锁定与升降说明是产品决策，不能从白名单字段直接推导。[Adapter 预检](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subagent/tool-subagent/src/model-selection.ts#L180-L199)。
- 结论 8 的“仅”过窄；更完整的 view 实现说明近作用域可遮蔽较远作用域，不只全局。同层冲突与 reserved name 结论保留。[作用域遍历](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/core/tools/src/index.ts#L191-L218)。
- `null`、未返回报告或被取消的调查都不能计作成功贡献；缩小读取范围后得到报告，也不能单凭结果归因为 Flash 性能提升。请求参数不是 actual request 证据；本研究没有独立采集实际请求，因此保留模型执行身份和性能的验证缺口。具体部署请求名称与失败流水不随报告迁移。

**后续发行复核：** rc.4 的模型选型和部分工具校验使用普通 `Error`，不能依赖本报告开发快照中的 `MODEL_SELECTION_DISABLED`、`MODEL_ROUTE_NOT_ALLOWED` 等细分码；也不能反向概括为 rc.4 完全没有结构化错误。见[rc.4 代理复核](<RC4-AGENTS.md>)及[现行实施约束](<../IMPLEMENTATION.md#2-原生执行选择保持原生>)。

正式决定见[原生代理接入](<../NATIVE-AGENTS.md>)。结论限于静态源码，未运行目标 DSH 选型、覆盖或授权测试。
