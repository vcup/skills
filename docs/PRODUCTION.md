# Ensemble 生产交付设计与验收

本文把[路线图](../ROADMAP.md)中的 C01–C17 转成 Module Interface、验证门与发布条件。它区分**已实现**、**已验证**与**尚未验收**：候选只有通过全部必要门槛并由非作者验收，才能称为生产就绪。面向安装者的操作说明见[仓库入口](../README.md)，维护者命令见[开发指南](DEVELOPMENT.md)。

<a id="current-status"></a>

## 0. 当前状态

正式包为 `dsh-ensemble@1.0.0`，本地构建、本地安装，**本地验收通过；未发布到 registry，也未推送到远端**。

冻结候选在同一 engineering bytes 上，完整 `release-check` 在 **DSH `0.2.2-rc.4` 与 `0.2.2-rc.5` 两个 Linux 安装上均 exit 0**；两次运行都实际执行了跨容器 source 门，浏览器门（`auth-ui-check`、`fresh-journey-check`）在各自版本上真实跑过。这证明的是**该候选在那两个受测发行版上的完整门范围**，不是公开发布，也不覆盖第 7 节的边界。

**本文件不携带逐次运行结论。** 每个门的权威结果是它自己的退出码：在冻结候选上运行本文[第 4 节](#4-验证门)的命令即可得到当时的答案。写进文档的只有稳定事实——包身份、受测集合、门覆盖什么、以及哪些事情没有被证明。

| 稳定结论 | 依据 | 不能据此声称 |
|---|---|---|
| 领域合同、协调与学习规则实现为封闭解码器与纯领域 Module | `modules/ensemble/` 无 DSH/FS/Git 依赖；`make test` 与独立领域审阅覆盖 | 存储、权限、执行世界或界面的行为 |
| 存档事务、原生身份边界、维护与环境账本各有独立门，且都以真实 rc.4/rc.5 发布包为运行对象 | `store-acceptance-check`、`native-acceptance-check`、`maintenance-check`、`environment-check` | 真实浏览器界面、最终候选字节、网络副本传输 |
| 打包、标准安装、CLI 与 Host 入口各有门 | `product-check`、`host-check`、`cli-check`、`matrix-check` | 已发布、已验收、模型回答质量 |

受测范围之外的边界见本文[第 7 节](#7-边界与交付范围)。**没有“生产就绪”总布尔值**：分别报告表达覆盖、领域流程、真实组合、故障恢复与运维演练。逐门结果出自 runner 的运行记录；本文只记录稳定事实与边界，不复述计数或摘要。

## 1. 产品与使用结果

正式 Ensemble 包采用 `dsh-ensemble` 身份，独立等待工具保留 `dsh-agent-wait` 身份。包名、版本号、DSH 支持范围和功能成熟度是四项独立事实；本候选以 `1.0.0` 为目标版本。改名不代表完成验收，本地 tarball 不代表已发布。

必须完成三条用户路径：

1. **新项目交付。** 用户配置档案位置并绑定工作区，明确授予 Lead 和成员权限；Lead 开工、通过原生代理分派工作；成员保存完整资料并提交贡献；Lead 取舍、验证候选和完成交付。中断后恢复不重放外部动作，未达到完成条件时明确拒绝。
2. **旧资料迁移与恢复。** 预览完整清单与缺口，按授权导入原字节并核对；保存未知内容和旧版本；能导出、备份，在独立环境恢复、重新绑定及授权。旧 probe 档案不得被静默升级或重新解释为当前授权。
3. **经验积累与再次应用。** 保存教学干预，起草反思，由非作者审阅确切版本后出版；在后续任务中检索有适用条件的经验、记录应用和反例，再进行更正或退役。已出版、已应用与已证明改善分别呈现。

纯 skill 与 OMP 保留既有消费方式和能力边界。独立等待插件不依赖 Ensemble 档案，默认无限等待、显式超时、取消和卸载行为保持兼容；它不抑制 DSH 原生完成通知。

## 2. Module 与 Interface

[托管词汇表](../GLOSSARY.md)区分身份、授权、源工作区、档案、资料与出版。各 Module 按事实所有权分工；同一个规则只保留一个执行位置。

| Module | Interface 承诺 | 内部拥有的复杂行为 |
|---|---|---|
| Coordination | 只读快照、封闭工作命令、可信事实 → 变更计划或拒绝 | 目标覆盖、成员绑定、贡献与取舍、候选、检查冲突、完成与恢复 |
| Learning | 同一快照、封闭学习命令、可信事实 → 变更计划或拒绝 | exact-version 审阅、阻断处分、出版、更正、经验应用与领域归属 |
| Policy | 当前授权与可信调用者 → 可执行动作或拒绝 | owner 与 Session 区分、有限委托、接管、替换、撤权、批准范围 |
| Projection | 已验证记录 → 有来源与版本的可读视图 | 检查点、历史、阅读、经验摘要；摘要不代替原文 |
| Archive | `execute` / `query` | 当前权限、幂等、锁、版本冲突、原字节与历史、原子发布、分页和结果对账 |
| Registry | 可信工作区绑定 → 唯一档案目标 | 多项目隔离、随机档案身份、绑定历史、停写与位置切换 |
| Native Adapter | 原生身份与引用 → 经核验事实 | Session 与树可见性、任务引用、请求选型与实际请求的区别 |
| DSH Adapter | 模型工具、owner Remote、CLI、Client | 参数解码、可信身份构造、取消传播、安装与卸载；不复制业务规则 |
| Maintenance | owner 预览与批准 → 可核对维护结果 | 上传、导入导出、独立环境历史、备份恢复、迁移与单主复制 |
| Environment | owner 偏好与原生设置实例 → desired/applied/unknown | 独立版本历史、CAS 应用、对账与恢复 |

`modules/ensemble/` 是纯领域代码，不导入 DSH、文件系统或 Git。原生接入与持久化留在 `adapters/dsh/`，分别是 `native/`、`tools/`、`store/`、`maintenance/`、`uploads/`、`environment/`、`client/`；不为去掉 probe 一词搬迁整个源码树。跨入口统一执行器的取舍见[架构决定](adr/0001-one-archive-executor.md)。

### 调用身份与项目选择

owner 仅来自当次已认证 Remote 的 principal。Session 身份来自真实工具执行上下文；无上下文不回退成 owner。输入不得携带 author、actor、reviewer、isVerified 或等价的权限声明。调用者在 payload 中引用其它成员，不会因此成为该成员。

open 许可允许调用者成为自己新建 invocation 的 Lead，不授予其它 invocation 的写权；撤销 open 后相应派生权失效，明确授予的 invocation Lead 权可独立保留。独立审阅必须对确切提案版本指派，宽泛的项目 review 权不能替代这项指派。

模型写目标由当前原生工作区、执行世界与 owner 绑定解析，不能传任意档案路径。多个匹配必须拒绝并由 owner 明确选择。查询可用 `project_id` 选择已获读取权限的项目，选择本身不授予权限。`ensemble_read` 的 `context` 查询返回当前绑定、可执行动作及 `read_revision`，让尚无 invocation 的调用者取得开工所需的版本。

世界身份由可信部署和 Adapter 提供；不能把相同地址文字当作同一资源。Host-local 档案使用独立 local subprocess/sandbox group，source 的读取经其原执行世界的受限能力完成。支持的容器组合必须真实验证；无法确认映射时拒绝，不猜测路径。`DSH_ENSEMBLE_SOURCE_WORLD` 缺失时模型工具明确拒绝，而不是默认放行。

### 一次写入的顺序

```mermaid
flowchart LR
    A[可信调用者与绑定] --> B[锁内读取当前授权]
    B --> C[查同主体操作收据]
    C --> D[核对 expected revision]
    D --> E[领域校验与变更计划]
    E --> F[完整记录 原文 投影 收据]
    F --> G[同一 ref 原子发布]
    G --> H[对账并返回原始提交结果]
```

同主体同重试键、相同业务内容返回第一次提交的结果；不同内容返回冲突。重试不因原 `expected_revision` 已过期就生成第二个动作，也不能在撤权后泄露旧结果。收据保留原提交定位，业务摘要不包含会随重试变化的传输字段。

当前授权与读取快照同序校验；历史权限不授予今天的读权。分页游标绑定查询、版本和授权代际，每页重新检查。撤权后 Client 丢弃旧代际迟到响应。

未知格式、损坏、缺少权限、锁忙与未初始化分别返回；不能把 Git 非零退出统一转换为“空档案”。提交前失败保持旧 head，提交点附近无法判断时返回结果未知并按收据对账。进程队列不能冒充跨进程锁，超时不能冒充可安全拆除旧锁的依据。完整错误码与重试语义见[命令约定](ensemble/COMMANDS.md#6-结果与重试)。

## 3. 数据与迁移

项目档案、环境偏好和原生凭证分别拥有存储与版本。环境应用的目标是本插件在原生 Settings 注册的 rolePreferences 实例，以 CAS 与读回记录 applied 或 unknown；推荐器消费有效实例，实际模型选型仍通过原生授权。不得改写子代理 trusted defaults 或自动切换已存在 Session，见[环境应用决定](adr/0002-role-preferences-do-not-grant-routes.md)。

档案身份为随机持久身份，不能从 source 地址计算；有损恢复使用新身份与新的重试命名空间。文件与目录使用私有权限，Git 子进程固定参数、剥离重定向环境、禁钩子与隐式网络。

记录采用封闭 schema；未知导入内容存为原始资料，而非容忍未知控制字段。原字节、digest、资料版本、判断版本及 archive commit 分别保存。附件不可经过 UTF-8 文本收集器；文本分页不能破坏编码。所有响应计算完整包络预算，部分结果带续读方式和缺口，不伪称完整。

### 旧 0.3 probe 档案

旧 `dsh-ensemble-probe@0.3.0` 档案先以只读形式识别，owner 预览并备份后显式迁移到新注册体系；旧 writer 停用，新身份与授权重新建立。保留原记录和原历史，旧字符串 grants 不自动成为有效授权。未知未来格式拒写，迁移失败保留原库；安装更新不得顺便迁移数据。两步 owner 操作、停写证据与不可逆边界见[版本支持与升级](UPGRADING.md)的“From `dsh-ensemble-probe` 0.3.0 to `dsh-ensemble` 1.0.0”。

## 4. 验证门

Make 是唯一验证入口。门（`*-check`）只在所有必需检查真实运行并一致时返回 0；**缺前置一律非 0，不允许以 skip 显示通过**。类别与副作用见[开发指南](DEVELOPMENT.md#完整-target-一览按目标分组)。

| 门 | 覆盖的产品行为 | 前置 |
|---|---|---|
| `check` | 内容漂移、仓库与模块类型、CLI bundle 闭包、文档引用 | bun、python3 |
| `test` | 全部单元与集成测试，含领域、存储、原生、维护、环境、Client 控制器 | bun |
| `host-check` | Host 入口类型 + 真实 Loader 加载已安装包 | `INSTALL_DIR` + 该目录内已安装候选包 |
| `product-check` | 标准安装候选 tarball 后：真实 AgentLoop 工具写入、已认证 owner Remote、随包 CLI | `INSTALL_DIR`、已构建候选 |
| `client-check` | 打包的 Client factory 在真实浏览器、官方 renderer 与 SlotRegistry 中运行 | 追加 `BROWSER`、`SLOTS` |
| `maintenance-check` | 引擎回归：导入导出、备份、恢复、迁移、迁移位置、复制、受批准清除 | `INSTALL_DIR` |
| `maintenance-live-check` | 已安装产品经随包 CLI 对真实 Host 的维护实跑（发布门用的是这个） | `INSTALL_DIR`、`PACKAGE` |
| `replica-acceptance-check` | 独立复制的 typed 反例（真实已认证 HTTP） | `INSTALL_DIR` |
| `environment-check` | 环境账本对原生 Settings，含响应丢失后的对账 | `INSTALL_DIR` |
| `selection-check` | 选型证据来自真实成员 Session 日志（不可读则 `unavailable`，不编造） | `RUNTIME` |
| `runtime-test-check` | 离线 `make test` 会跳过的 native 测试族，真实执行；**除 live CLI 一族外任何 skip 即失败**，live CLI 缺可选凭证时如实记为 skipped | `INSTALL_DIR`；可选 `LIVE_ORIGIN`、`LIVE_COOKIE_FILE` |
| `live-cli-test` | `cli.test.ts` 的 live lane（`packaged CLI against a live Host`）：自起 Host，跑 `projects` → `query{kind:context}` → `manage pause` → `manage resume` → 重读校验 revision/epoch；skip / fail / 零用例即失败。这是**单个 Host 上的本地管理写与回滚**，不含复制 | `INSTALL_DIR`、`PACKAGE`、`PACKAGE_SHA256` |
| `store-acceptance-check` | 非作者独立存档事务、损坏与 CAS 反例 | `INSTALL_DIR` |
| `native-acceptance-check` | 非作者独立执行世界与身份边界 | `INSTALL_DIR` |
| `source-acceptance-check` | 跨容器 source 读取（注册制 fixture） | `INSTALL_DIR`、`ENSEMBLE_SOURCE_TEST_TOKEN`、`ENSEMBLE_SOURCE_TEST_URL` |
| `fixture-test` | 仅测试用 source-world 服务的契约测试 | bun，离线 |
| `matrix-check` | 已打包清单声明的受测版本与维护声明一致 | 已构建包 |
| `cli-check` | CLI 在两个受测发行版的新 profile 中安装、运行、卸载 | `RC4_INSTALL` 与 `RC5_INSTALL` |
| `auth-ui-check` | 真实 Host 下发 cookie + 真实浏览器加载随包 Client：owner 写入、revision 前进、停 cookie 后失去管理 | `INSTALL_DIR`、`PACKAGE`、`BROWSER` |
| `fresh-journey-check` | 全新安装旅程：浏览器经官方 UI 创建 Workspace，Client 绑定它 | `INSTALL_DIR`、`PACKAGE`、`PACKAGE_SHA256`、`BROWSER` |
| `source-acceptance-sidecar-check` | 自起/自停容器的跨容器 source 门（发布门用的是这个） | `INSTALL_DIR`、容器运行时 |
| `typecheck-strict` | 完整类型声明：两个 plain + Host + Client program + 闭包检查（覆盖 `.ts`/`.tsx`/`.mts`/`.cts`）；离线部分已确认每个 plain maintained 文件都在某个 program 中，36 个 runtime-typed 文件只有本门（带真实 install 与 Client types）才会编译 | `INSTALL_DIR`、`CLIENT_TYPES` |
| `production-check` | 产品门按依赖顺序串联，**不含**浏览器门与跨容器门 | `INSTALL_DIR`、已构建候选 |

[发布门](DEVELOPMENT.md#清理与交付)组合这些门，且**没有任何可选门**：它与当前 Makefile 的先决条件逐项一致——`check`、`test`、`inspect`、`matrix-check`、`typecheck-strict`、两个插件的 Host 类型与真实 Loader、`wait-runtime-check`、`maintenance-live-check`、`selection-check`、`live-cli-test`、`runtime-test-check`、`production-check`、`replica-acceptance-check`、`client-check`、`auth-ui-check`、`fresh-journey-check`、`source-acceptance-sidecar-check`。缺 `PACKAGE_SHA256`、`BROWSER`/`SLOTS`/`CLIENT_TYPES`、缺容器运行时或 fixture 时 exit 2，不存在“打印未验证项但返回 0”的路径。

三层不要互相冒充：`package-check` 是离线聚合（含 plain 类型子集，不含任何 install 或浏览器）；`production-check` 是已安装产品的聚合（不含浏览器门与跨容器门）；只有 `release-check` 可作为发布结论。发布结论要求 `PACKAGE=` 与 `PACKAGE_SHA256=` 指向**同一个不可变 tarball**，且 `release-check` 强制这一点：缺 `PACKAGE_SHA256` 或格式不合法即 exit 2，与实测字节不符则在安装任何东西之前拒绝。需要未 pin 的诊断时用 `package-check`/`production-check`，它们声明自己不是发布结论。

## 5. 实现批次与验收责任

批次是依赖顺序，不是删减最终范围。

| 批次 | 对应承诺 | 必须出现的运行证据 | 状态 |
|---|---|---|---|
| 事务与管理 | C05、C07、C08 | 双进程 CAS／撤权竞争、同键重试与冲突、响应丢失对账、损坏与未初始化区分、重启及 source 零污染 | 由 `store-acceptance-check` 在双版本上以非作者反例覆盖 |
| 完整协调与原生协作 | C02、C03、C06、C09、C16 | 真实 ToolRunner 与原生子代理交付往返；替换后迟到提交拒绝；所有必要覆盖与检查冲突参与完成判定 | 领域规则、原生身份边界与端到端交付往返（`product-check` 的 `core`／`learning`／`team` phase）均在冻结候选的双版本运行中执行 |
| 学习与环境 | C04、C10、C11 | 非作者 exact-version 审阅，阻断不能被另一个 approve 绕过；下一任务应用与反例修正；环境 desired／applied／unknown 可恢复 | 领域规则由 `make test` 覆盖；环境账本由 `environment-check` 覆盖 |
| 完整用户表面与资料迁移 | C07、C12、C13 | 官方 Client 注册并实际渲染；权限变化与重连；完整未知字节导入／导出，源变化拒绝 | 迁移与维护门通过；冻结候选上的真实浏览器与已认证 Host 界面由 `client-check`、`auth-ui-check`、`fresh-journey-check` 在双版本执行 |
| 长期维护 | C14、C17 | 独立备份恢复、停写换根、新身份有损恢复、故障注入、容量上限；显式远端复制与隔离获取 | 由 `maintenance-live-check`／`maintenance-check` 与 `production-check` 的 `network` phase 覆盖；跨物理 Host／TLS／WAN 属适用边界，不是缺失 |
| 分发与发布验收 | C01、C15 及以上全部 | 独立标准安装／升级／卸载／恢复，纯 skill 与 OMP 回归，三条用户路径、双版全门、最终差异审查 | 打包与安装门通过；同一冻结候选在 rc.4 与 rc.5 上完成整门 `release-check` |

### 5.1 逐项承诺与可取证的门

下表只做归属，且每条都写明**该门实际执行了什么**——依据是 driver 本身（`adapters/dsh/native/verify-product.mjs` 的 phase 体、各 `scripts/verify-*.ts` 的断言），不是门名。**不含成绩、计数或摘要**：门的权威结果是它自己的退出码。

缺口分两类，不能混：
- **测不到** — 目标能力本身没有可用的门；现有门只能证明相邻事实。
- **未授权** — 需要外部动作（发布、推送、远端基础设施），不属于本地产品可完成的测试。

下表的门都在冻结候选上、在 rc.4 与 rc.5 各跑过一遍（`release-check` 的组成部分）；表里写的是**每个门实际执行了什么**，不是成绩。

| 承诺 | 可取证的门与其真实动作 | 边界（测不到 / 未授权） |
|---|---|---|
| C01 单份方法源；三条路径独立产物 | `check` 比对提交的 skill 与源码生成结果；`matrix-check` 读打包清单与维护声明比对；`install-smoke` 真实安装锁定的 skills CLI 并逐字节比对；`product-check` 安装 tarball 后跑 native phase | **未授权**：registry 发布与远端安装地址。本地安装可测，远端分发不可测 |
| C02 Lead 编排、教学包、独立首轮 | **`production-check` 的 `learning` phase**（`adapters/dsh/native/verify-learning.mjs`，经官方 `--profile web` composition 跑）：`open → plan_attempt → 绑定真实可续成员 → 该成员写 artifact+contribution → candidate → accepted decision → reported check → challenge → 取代性观察 → complete`；随后 `learn`：coaching → 作者本人 reflection → owner 指派**第二个**真实成员做独立审阅 → publication → lesson；再 `next`：新 invocation 让成员把 lesson 应用到未见案例 → 独立检查 → `supported`。成员投递用 `subagents.sendMessage` 并**断言 inbox 已接受**，不是假定。`core` phase 另证认证栅栏与 archive `initialize`/`bind`；`team` phase 证 Team 默认关闭仍可写入。`fresh-journey-check` **不**证明成员交付往返——它只证 GUI 建 Workspace + Client bind | **测不到**：付费模型质量 |
| C03 spawn 的 route/effort/preset；fork 保持原路由 | `selection-check` 读真实成员 Session 日志断言四件事（不可读→`unavailable`、他 Session 不归属、请求模型与实际不同仍报真实值、重复读逐字节一致）；`runtime-test-check` 把离线跳过的 native 测试族真实执行 | **测不到**：`actual request` 取决于原生日志可读性，不可读即 `unavailable`，无法补 |
| C04 环境偏好独立存储、版本、恢复 | `environment-check`：真实 Git 提交 desired、原生 Settings CAS 写入、读回 applied/unknown、响应丢失后不盲重发 | 无：门已覆盖 |
| C05 工作区外档案；绑定/授权/接管/撤销 | `store-acceptance-check` 11 个具名用例：`archive-symlink`、`corrupt-ref`、`corrupt-receipt`、`receipt-authority`、`cursor-authority`、`corrupt-snapshot`、`response-lost`、`kill-restart`、`concurrent-writers`、`identity-grants`、`ambient-environment` | 无：门已覆盖 |
| C06 状态模板全字段、生命周期、完整恢复 | 字段契约由**领域单元测试**逐项证明：`modules/ensemble/codec.test.ts` 校验封闭 schema 与往返，`acceptance.test.ts` 覆盖生命周期与判据（`complete requires every critical criterion and preserves reported provenance`、`new candidate never inherits old checks`、`reopen`/`retire` 相关用例等）；**完整真实 I/O** 由 `product-check` 的 `core`＋`learning` phase 承担（open→…→complete、teaching/reflection/review），记录与收据的持久往返由 `store-acceptance-check` 证明 | 无"每字段一个生产门"这种要求；字段级正确性以领域测试为准，端到端以 product phase 为准 |
| C07 完整正文、未知内容、附件、修订、历史 | `maintenance-live-check` 经随包 CLI 做导入导出与备份恢复；`store-acceptance-check` 的 `corrupt-snapshot`／`corrupt-receipt` 证明读回不宽容 | 无：门已覆盖 |
| C08 原子发布、幂等、CAS、结果未知恢复 | `store-acceptance-check` 的 `concurrent-writers`（跨进程 CAS）、`response-lost`（响应丢失对账）、`kill-restart`（重启后不重放） | **测不到（适用边界）**：真实断电只有 fsync 级证据 |
| C09 候选版本、验证证据、适用性、来源 | `product-check` 的 `core` phase 记录 candidate 与 check；`selection-check` 区分 requested/created/actual | **测不到**：旧观察复用的"适用性"是人工判断，不是门 |
| C10 反思草稿/审阅/出版/更正、原文保留 | `product-check` 的 `learning` phase（`runLearningJourney`：coaching→reflection→非作者审阅→出版→更正） | **测不到**：出版后的教学迁移效果 |
| C11 概览与分域阅读、跨域引用、经验检索/失效 | `learning` phase 内的 reading/lesson 查询；`test` 中的 projection/query 套件 | **测不到**：检索质量无 benchmark |
| C12 授权看板、原文/历史/证据、管理入口 | `client-check`（组件级：打包 factory 在真实浏览器+官方 renderer 渲染）；`auth-ui-check`（真实 Host 发 cookie、真实浏览器写入、停 cookie 后失管理）；`fresh-journey-check`（新 Host 经 UI 建 Workspace 并 `initialize`/`bind`） | **测不到**：完整界面"全部路径"没有单一门；`auth-ui-check` 覆盖它自己断言的组合流程 |
| C13 导入、预览、去重、缺口报告、显式导出 | `maintenance-live-check`（随包 CLI 对真实 Host）；`maintenance-check` 引擎侧的 transfer 用例 | 无：门已覆盖 |
| C14 schema 升级、备份恢复、换根、诊断、卸载保留 | `maintenance-live-check`（含 relocate、restore 激活、uninstall-retain）；`maintenance-check` 引擎回归 | 无：门已覆盖 |
| C15 支持范围、预算、产物、各路径文档 | `matrix-check`（清单声明 vs 维护声明）；`cli-check`（两发行版新 profile 安装/运行/卸载）；`package-check`；`docs` | **未授权**：发布与远端地址，不是缺 feature |
| C16 原生成员身份、任务绑定、等待、权限、冷恢复 | `native-acceptance-check`（身份/执行世界边界）；`wait-runtime-check`（真实等待生命周期）；`runtime-test-check`（native 族真实执行）；`product-check` 的 `team` phase（spawn 真实成员 + 读其 Session log） | 无：门已覆盖 |
| C17 单主显式远端复制、隔离获取、恢复 | **`production-check` 的 `network` phase**（`adapters/dsh/native/verify-product.mjs:1007-1160`，标准 profile 内跑，宿主是 `scripts/fixtures/git-auth-server.mjs` 这个**独立进程**的认证 HTTP Git 服务）：① owner Remote 读回部署声明的 `destinations`；② `choose {kind:"replica", destinationKey, world}` 返回不透明 `location_…` 能力，且断言该 world **不等于** Host 世界（否则会静默走本地 `file` 路径）；③ `configure_replica` 完成真实认证往返；④ `push_replica` 成功且远端 `refs/ensemble/main` 等于被推 revision；⑤ 另一个 writer 经**同一条认证 URL** 真实 clone 并推进远端，陈旧 push 被 `remote_conflict`/`revision_conflict` 拒绝且远端不变；⑥ `fetch_replica` 产出只读候选且主 head 不动；⑦ 删除凭证文件后下一次 push 被拒、远端与主 head 均不变。部署声明走 `DSH_ENSEMBLE_REPLICA_DESTINATIONS`（`url`/`identity`/`credential_ref`/`credential_username`），secret 只存 `$DSH_HOME/.credentials.yaml`（0600），不进 argv/URL/日志。旁证：`replica-acceptance-check` 的九个用例（含 `http-credential-usage`、`interleaved-destinations`、`credential-containment`）覆盖 transport 语义，**不等于**上面这条产品内认证路径 | **适用边界**：受控 **loopback** 认证 HTTP endpoint；**未证明**跨物理 Host、TLS/WAN 或真实第三方主机。这是 C17 内部的边界，不是 C17 的实现缺失 |

表中不再有"未跑"项：列出的门都在冻结候选的两个受测发行版上执行过。

## 6. 发布门槛

- 默认 `make check` 保持离线；测试、打包、原生运行与需要网络的步骤各自明确。CI 覆盖产品源码，不能只监听内容文档变更。
- 每个包的 exports、bin、Client factory、技能资源、peer 和产物清单互相闭合；离开源码 checkout 仍可用。相同输入构建出相同字节，校验 digest，并提供版本变更与迁移说明。
- rc.4、rc.5 分别在标准 DSH 安装中验证，不强制 peer、不过版本豁免、不混入另一版 Host 副本。新增版本按[生命周期规则](UPGRADING.md)中的“Supporting a future DSH release”验证；`latest` 仅是观察，不是许可。
- 必要原生测试不能靠缺少环境变量而 skip 后显示发布通过。端到端测试脚本纳入仓库，不依赖维护者的临时报告、特定绝对路径或既有登录状态。
- 软件可用性与模型效果分开。确定性模型 Adapter 可以验证真实原生执行路径，但不能证明真实模型的任务适任性或教学迁移效果；相关主张必须有相应证据。
- 关键错误给出稳定代码与可采取的下一步；日志不含凭证、完整请求或私有正文。卸载取消在途准备并保留数据，恢复不重放外部副作用。
- 最终候选由非作者按需求与外部契约验收；没有证据的项目保持未通过。公开发布、推送和 live profile 部署另按用户授权执行。

## 7. 边界与交付范围

本节列出**受测范围之外**的内容，分两类：交付边界（需外部授权或外部条件）与证据边界（任何声称都不得超过的范围）。已由冻结候选双版本运行证明的部分不在此列。

**一条仍需读准的事实：**“离线 `check` 绿”不等于“全部类型已编译”。离线部分只覆盖 plain maintained 文件；36 个 runtime-typed 文件需要真实 install 与精确 Client types，只有 `typecheck-strict` 会编译它们——该门是发布门的一部分，因此随 `release-check` 一起在双版本执行。

### 7.1 交付边界（不作本轮发布 blocker）

| 项目 | 为什么是边界而不是必做 |
|---|---|
| CI 在远端实跑 | 本会话没有远端触发权限，也无权为跑 CI 而推送；工作流文件不是通过记录。CI 已按同 runner 的 source sidecar + 浏览器供应 + 同字节 `PACKAGE`/`PACKAGE_SHA256` 写好，但从未在 GitHub 上执行过 |
| registry 发布与发布地址 | 未发布，也无发布地址；用户未授权发布。本地 tarball 安装不延伸为发布成功 |
| 模型能力与教学迁移效果 | 确定性 provider 证明执行路径，不证明付费模型的回答质量或教学迁移 |

### 7.2 证据边界（必须在报告中如实标注）

物理 Host 隔离（跨执行世界证据只限容器级文件系统隔离）、付费模型质量、macOS/Windows 支持。这些不是本轮验收阻塞项，但任何声称都不得超过上述范围。

历史交付记录（含当时未验项）保留在 [P1 交付记录](ensemble/P1-DELIVERY.md)；新实现不继承他的成熟度判断。
