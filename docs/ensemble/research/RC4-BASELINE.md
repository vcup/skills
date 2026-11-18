# DSH rc.4 发布基线与 ensemble 影响

本文保留原研究的发布查询、源码核验与 Lead 更正。可变标签描述的是**原研究查询时**的结果，迁入正式仓库时未重查实时标签；当前接入决定见[设计入口](../README.md)与[实施要求](../IMPLEMENTATION.md)。

## 发布与源码身份

- 原研究读取 npm registry 时，`@deepseek-ai/dsh` 的 `next` 为 `0.2.2-rc.4`，`latest` 为 `0.2.2-rc.1`。引用与首次安装目标固定精确版本，不依赖浮动标签。[dist-tags 查询入口](https://registry.npmjs.org/-/package/@deepseek-ai%2Fdsh/dist-tags)。
- 精确发布包要求 Node `>=24.9.0`；tarball shasum 为 `3906b6f86a36c25475da1a8aec6d9095f5a06b0b`。metadata 没有 `gitHead`；源码使用官方标签 `dsh-v0.2.2-rc.4`，解析为 `3f321d32bfe382212a8ed8785c1d47a5a300aa23`，包清单版本一致。不声称已重建并比较 tarball 字节。[npm 精确版本](https://registry.npmjs.org/@deepseek-ai%2Fdsh/0.2.2-rc.4)、[包清单](https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/package.json#L1-L9)。
- 原研究基线 [`39163dd30f703a79079e2d2446545cff3c453738`](https://github.com/deepseek-ai/deepseek-harness/commit/39163dd30f703a79079e2d2446545cff3c453738) 是 master 的 rc.3 同步提交，**不是正式 rc.3 发布 tag**；它与 rc.4 非线性。`git rev-list --left-right --count OLD...RC4` 得到 `608 8`；共同祖先为 [`38a6a5c965aa99ab525161efb7cc5cf1fe62fced`](https://github.com/deepseek-ai/deepseek-harness/commit/38a6a5c965aa99ab525161efb7cc5cf1fe62fced)，恰为正式 `dsh-v0.2.2-rc.3`。不能把两个端点 3487 个文件的差异都称为 rc.4 新增或回退。
- 原核验保持旧 checkout 的 SHA，在独立 worktree 核验新版本；引用校验器按 SHA 选择对应 checkout。旧研究记录保留旧证据，现行设计与路线图改用 rc.4 发行 SHA。这些 checkout 不属于正式研究交付物。

## 正式 rc.3 → rc.4 的净变化

`git diff dsh-v0.2.2-rc.3 dsh-v0.2.2-rc.4` 共 395 个文件，排除根与各包 `package.json` 版本更新后仅 15 个路径；运行时代码仅以下三个文件变化，其余是说明、测试与 snapshot。

1. DeepSeek Messages 的 `stop_reason: refusal` 由 `MALFORMED_RESPONSE` 改为 `CONTENT_REFUSED`，保留 provider explanation，并在失败前报告 usage；新增共享 LLM 错误码。ensemble 须保留失败状态，不能把拒答当成功贡献。最终发布净 diff 没有新增 `safetyCheck` 可配置开关，不能依据中间 commit 标题推导最终功能。[官方迁移说明](https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/docs/upgrade-guide/v0.2.2-rc.3/deepseek-refusal-code/guide.zh.md#L10-L17)、[流式转换](https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/llm/llm-deepseek/src/translate.ts#L90-L163)、[错误码](https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/llm/llm/src/error.ts#L20-L30)。
2. Desktop liveshare tunnel worker 继承 Host 的 `ELECTRON_RUN_AS_NODE`，避免复用 Electron executable 时误作为 GUI 进程启动。此修复不改变本设计的外置 archive、原生代理树或任务分派。[worker 启动](https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/experimental/liveshare/src/host/tunnel-worker.ts#L70-L94)、[环境派生](https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/experimental/liveshare/src/host/tunnel-worker.ts#L367-L379)。

**正式标签之间 subagent、Team、workflow、选型 preset 实现没有变化。**

## 原开发基线 → rc.4 发行接口

以下是开发 snapshot 与发行提交的端点比较，不是正式 rc.3 → rc.4 的发布变更。

- 核心行为保留：同树互通；fresh 成员访问/领取启用的共享任务；spawn 选择 provider/model/effort；fork 默认关闭选型；workflow 没有 effort 字段。按任务与上下文匹配选择创建/续用的决定不变。[代理复核与 Lead 处分](RC4-AGENTS.md)。
- 发行版的选型/部分工具校验使用普通 `Error`，缺少原开发基线的细分码；`SubagentError` 及部分 code 仍在，不能统称无结构化错误。workflow 结果没有 `errorCode`。原研究将这些区别写入实施要求与 R20，不声称当前插件已使用这些 API。
- skill 包无 `SkillError` 出口；Cordis 根上下文使用 `ctx.root`，不能照抄开发基线的 `ctx[Context.root]`。Remote 授权、Host local subprocess/sandbox、storage 限制及公开 Client factory 约定可保留。未实现的代码需按发行包类型编译。[插件接口复核与 Lead 处分](RC4-PLUGIN-SEAMS.md)。
- 同名注册/近作用域覆盖依据的 `core/tools/src/index.ts` 两端完全相同；fork 测试锚点已重新读至 L543–576；消息与选型等引用已重定位。对尚待实现的 archive 仍保持自己的 failure code，不强行映射所有原生错误。

## 修改与证据限制

原研究更新了现行[设计入口](../README.md)、[领域模型](../DOMAIN-MODEL.md)、[代理接入](../NATIVE-AGENTS.md)、[实施要求](../IMPLEMENTATION.md)、[路线图](../../../ROADMAP.md)。可移植方法无需因发行版本号而改写；旧研究与演进历史保留原基线。另见对历史 `latest` 所指版本的 [rc.1 兼容性检查](RC1-BASELINE.md)。

两路源码复核通过 workflow 委托完成；Lead 复核净 diff 与关键源码，纠正了把端点删除称为发布变更、从 sandbox 注释推导更早失败等过强表述。未运行目标 DSH 测试、构建、安装或 GUI 更新。原核验容器没有 npm，首条 `npm view` 以 127 退出后改用公开 registry HTTP；没有为文档核验安装工具链。新 worktree 不能作为 bash workdir 路由，后续 Git 统一从项目根用 `-C` 操作；没有改容器权限。
