# 历史 npm latest 所指 rc.1：快速兼容性检查

原核验时间：2026-11-18（Asia/Shanghai）。本文保留当时的发布元数据查询与代理协作源码检查；迁入正式仓库时未重查实时标签。该检查不更改 ensemble 的 rc.4 设计基线，也不安装或升级运行环境。现行目标见[设计入口](../README.md)及 [rc.4 发布基线](RC4-BASELINE.md)。

## 发布身份

- 原研究查询时，npm `latest = 0.2.2-rc.1`，`next = 0.2.2-rc.4`；rc.1 的 Node 要求为 `>=24.9.0`。`latest` 标签不能作为 rc.4 接口已经可用的证据。[dist-tags 查询入口](https://registry.npmjs.org/-/package/@deepseek-ai%2Fdsh/dist-tags)、[精确版本](https://registry.npmjs.org/@deepseek-ai%2Fdsh/0.2.2-rc.1)。
- 官方标签 `dsh-v0.2.2-rc.1` 解析为 [`66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`](https://github.com/deepseek-ai/deepseek-harness/commit/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db)。原研究用 Git 验证它是 rc.4 发行提交 `3f321d32bfe382212a8ed8785c1d47a5a300aa23` 的祖先：`rev-list --left-right --count RC1...RC4` 为 `0 1582`。提交数量包含合并历史，不作为独立功能数或成熟度指标。

## 与 ensemble 方案有关的差异

| 方面 | rc.1 | rc.4 |
|---|---|---|
| 成员体系 | 普通 subagent 与实验性具名 Team 分开；后者拥有独立 roster，Lead 使用 `spawn_teammate` | 统一原生子代理树，Team 只增加可选共享任务板 |
| 普通 subagent 通信/发现 | `send_message({agent_id,...})` 仅支持直系父子；`list_agents({scope})` 列出自己的子/后代，非整树可通信目录 | `send_message({agent,...})` 联系同树其它成员；`list_agents` 列出整树 |
| 共享任务 | Team 已有依赖、CAS 领取与所有权；普通 subagent 不因被创建就成为同一 Team 成员 | Team 开启且工具可用时，同树可续聊成员共享任务 |
| fresh 协作成员 | 已支持 `spawn_teammate({context:'fresh'})`，默认即 fresh；也有 fork 选项 | 通过普通 `subagent` 创建，不再需要专用创建器 |
| Team 创建时选型 | `spawn_teammate` 只有 name/description/prompt/context，无每次 LLM provider/model/effort 字段；config 的 freshProvider/forkProvider 是执行 backend | 复用普通 subagent 的获准选型参数 |
| 等待 | Team `wait_agent` 可因成员、消息或 task 变化返回；不会因此自动启动 owner | 原生 `wait_agent` 只等待调用者 next-step inbox，task 变化本身不结束等待 |

依据：[rc.1 普通控制](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/subagent/tool-subagent-control/README.md)、[rc.1 Team 说明](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/experimental/agent-team/README.md)、[rc.1 Team 创建与工具执行](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/experimental/tool-agent-team/src/index.ts)、[rc.4 Team 说明](https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/team/agent-team/README.md)。

普通 subagent 的模型选择并非 rc.4 才引入：rc.1 已有 provider/model/reasoning_effort，标准 spawn 也已开启选型与发现。rc.1 允许仅传 reasoning_effort；rc.4 要求同时提供 provider/model，显式选路线但省略 effort 时会清除继承 effort，即使路线没有变化。rc.1 路线不变时可保留配置/兼容父 effort，不能混用两版省略语义；详见[定向选型核验](RC1-MODEL-CHECK.md)。**不要把“Team 创建器没有选型参数”误写成“rc.1 没有选模型能力”。**

## 结论与范围

rc.1 并非没有 fresh Team 协作；它缺少现行方案依赖的统一代理协作入口。若要支持 rc.1，需要单独定义旧 Team 的兼容范围与选型适配，不能仅改最低版本声明。现行目标继续固定 rc.4。原研究之前的部署探针表现出直系消息与单独具名 Team，与 rc.1 实现一致，但这不能单独证明当时正在运行的安装版本。

研究依据为正式标签源码、Git 净 diff 和 npm registry；未运行 rc.1 测试、打包或安装，也未断言发布者保留 `latest` 标签的原因。原检查没有改动产品文档或运行配置；本次整理仅迁入研究记录。
