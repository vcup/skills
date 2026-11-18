# RC4 插件接缝核验

本文整理对[实施要求 §3–§4](../IMPLEMENTATION.md#3-host工具与权限接入)的历史静态核验，保留初查发现、Lead 更正与未确认项。比较基线为旧开发 snapshot `39163dd30f703a79079e2d2446545cff3c453738` → 正式 `dsh-v0.2.2-rc.4`（`3f321d32bfe382212a8ed8785c1d47a5a300aa23`）。旧提交不是正式 rc.3 tag；两端非线性，旧独有 608、新独有 8。下文“无实质变化”“删除/改为”仅指这两个端点的 diff，不能据此归因正式 rc.3 → rc.4 的发布变化。正式标签身份与净 diff 见[发布基线](RC4-BASELINE.md)。

源码均引用 rc.4 固定 SHA；§3、§4 指实施要求的 Host/工具/权限与 Client/包构建章节。原设计没有使用下列 `SkillError`、`Context.root` 或自建 client bundle 路由；这些是未来实现的发行类型约束，不是已经修复的插件代码问题。

## §3：Host、工具与权限

1. **skill provider 契约成立，但不能依赖开发 snapshot 的错误类型出口。** `ctx.skills.register()`、`SkillDefinition`、`resourceBase` 均在（skill 的 L94、L170）；skill-filesystem 以 `{kind:'directory',path}` 提供 opaque `resourceBase`（L227）。发行版不导出 `SkillError` / `SkillErrorCode`，provider 校验失败抛 `TypeError` / `Error`。插件若 catch `SkillError` 分支会失效；§3“公开 skill provider”仍成立，但不得引入对 `SkillError` / `SKILL_INVALID_DEFINITION` 的依赖。[skill API](https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/skill/skill/src/index.ts#L94)、[filesystem resourceBase](https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/skill/skill-filesystem/src/index.ts#L227)。
2. **subprocess/sandbox 接缝成立；未发现支撑“更早失败”的行为变化。** subprocess-local 仅有包版本变动，`LocalSubprocessRuntime` 默认导出未变（L77）；sandbox-local 的 `confine()` 链未改。sandbox 对 `SANDBOX_ESCALATION_UNAVAILABLE` 的注释新增“sandboxing executor 缺失”（L28–29）。初查由此推导“约束不可用时更早失败”，**Lead 因没有行为证据而不采纳该推论**。§3“无法约束时失败、不启用 unconfined fallback”仍是设计要求，Host 隔离与 sandbox 执行规则需要原计划的真实组合验收。[本地执行器](https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/subprocess/subprocess-local/src/index.ts#L77)、[escalation 注释](https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/sandbox/sandbox/src/escalation.ts#L28-L29)。
3. **remote-access 授权面成立。** `allows(resource)` 签名未变（L235）；`bindings()` / `explain()` / `refusal` 语义未变；本区间只有包版本变动。§3“`remoteAccess.allows` 在 Remote 外不是通用授权检查”与源码注释（L4、L227）一致。[remote-access](https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/api/remote-access/src/index.ts#L235)。
4. **settings 契约成立，根上下文访问方式不同。** `.volatile()` 仍是 live 编辑入口；`volatileForm()` 按最近 volatile 祖先选字段（schema L37），`update/replace(ns, patch, expectedRevision?)` 仍在（L348、L358）。端点差异是 `ctx[Context.root].loader` → `ctx.root.loader`（L235）；未来插件应按发行类型使用 `ctx.root`。[Settings 实现](https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/settings/settings/src/index.ts#L348)、[volatile schema](https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/settings/settings/src/schema.ts#L37)。
5. **storage-json 无实质变化。** 两端仅包版本变化。§3“JSON backend 无跨进程锁、可能持有旧 snapshot，不能做第二 archive 真源”的结论仍由 README 与行为论证支持，源码未新增保证。[包清单](https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/storage/storage-json/package.json)、[storage 限制](https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/storage/storage-json/README.md#L135-L145)。

## §4：Client 与包构建

6. **cookbook §5 的对外发布约定成立。** 两端的 `adding-a-settings-card.md` diff 为空：bare-package Loader row 承载 half（L58）；`./client` 必须使用 lazy-CJS `factory(require)` 格式（L60）；`dsh.client` 有字段样例（L68）。`clientBundle` preset 位于 `packages/client/tsdown.client.ts`，**不发布**；仓外包须自行复刻，不能从临时源码 checkout 导入。[公开发布约定](https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/docs/cookbook/adding-a-settings-card.md#L58-L68)。
7. **client/modules 的端点差异是路由 `auth` 字段不再出现。** 旧 `webServer.register({kind:'prefix', path:PLUGIN_ROUTE, auth:'anonymous', ...})` 在发行提交去掉 `auth`（L705）。外部插件若自建 bundle 路由并照抄 `auth:'anonymous'`，在该发行类型下可能多余或报错。§4“按公开 lazy-CJS 约定构建”不受影响，但不应复用带 `auth` 的旧样例。这不是正式 rc.3 → rc.4 的发布变更。[client modules](https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/client/modules/src/index.ts#L705)。
8. **§4 依赖的 slot 契约存在。** `plugins.detail.actions/badge/section` 位于 slot-contract 的 L173、L178、L185；`plugins.item` 与 `configForms.whileServed` 位于 ui-settings-shell Client 的 L50，与 cookbook §4（L72）一致。[slot 契约](https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/client/ui-plugin-manager/src/client/slot-contract.ts#L173)、[设置 shell](https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/packages/client/ui-settings-shell/src/client/index.ts#L50)、[cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/docs/cookbook/adding-a-settings-card.md#L72)。
9. **`form.state` / `form.mutate(operations, expectedRevision)` 的声明来源未定位。** cookbook §3（L42）说明由 Plugins 页 owner 传入，两端 diff 为空；初查在 ui-plugin-manager / ui-settings-plugins 的 src 内搜索，没有找到该签名定义。可能通过 `ctx.slots.register` 的 owner props 泛型注入，或位于类型声明文件，但未确认。当前 ensemble 设计没有自述该接口；保留为将来选择设置卡方案时的核验项，不把“未查到声明”写成“API 不存在”。[cookbook 的表单说明](https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/docs/cookbook/adding-a-settings-card.md#L42)。

## Lead 复核处分

- “删除/改为”只表示开发 snapshot 与发行提交的端点差异；不归因正式 rc.3 → rc.4。原设计未使用 `SkillError`、`Context.root` 或自建 client bundle 路由；发行类型约束进入[实施要求](../IMPLEMENTATION.md)，不声称修复了不存在的实现。
- 第 2 项从注释变化推导“更早失败”没有行为证据，不采纳；Host 隔离与 sandbox 执行规则仍须真实组合验收。
- `form.state` / `form.mutate` 不是当前 ensemble 自述接口。将来采用设置卡方案时再核验；未找到声明不等于不存在。

## 未确认与实施交接

- §4“记录状态与 native runtime 状态用不同标签”等产品行为不在本次接口核验范围，未验证。
- `form.state` / `form.mutate` 的确切类型来源未定位；采用该方案时，先引用 cookbook L42，不把推测签名写成已验证契约。
- §3 使用公开 skill provider 时，不能隐含依赖 `SkillError` / `SKILL_INVALID_DEFINITION`。
- 未运行构建或测试；未验证仓外复刻 tsdown `clientBundle` 的可复现性，也未核对 prerelease 依赖可得性。
