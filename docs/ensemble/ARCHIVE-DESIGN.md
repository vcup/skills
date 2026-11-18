# 插件管理的外置档案与工具

这是待实施的 Interface。完整业务状态见[领域模型](DOMAIN-MODEL.md)，字段、权限与错误以[命令约定](COMMANDS.md)为准；持久布局、owner管理、预算及迁移见[运行管理](OPERATIONS.md)。旧 `.ensemble/` 的逐项替代见[替代矩阵](REPLACEMENT-MAP.md)。目标是**所有协调数据和高频历史都在工作区外，由程序维护；模型表达领域动作和正文内容，不维护文件树**。

## 1. 存储归属与部署

Host 配置一个私有、持久的 `archiveRoot`，由程序在其下为项目建立独立 Git 仓库。根路径必须位于所有绑定 source workspaces 之外；重绑/新增 source 时重新验证，拒绝重叠、symlink/reparse 越界及用户已有非托管目录。同域以实际规范身份核对；跨Host/container/SSH须依据可信部署拓扑或显式mount映射，不能用路径字符串不包含就证明隔离，无法确认时拒绝启用该绑定。路径只能由部署配置/用户绑定操作决定，模型工具没有 path、cwd、shell、remote URL 或任意 Git 参数。

默认既不在 source 创建 `.ensemble/`，也不创建 symlink、submodule、gitlink 或导出镜像。程序的可读 Markdown 在档案 Git tree 中，UI/工具按文档身份读取；用户显式导出才产生普通文件。导出到 source 是用户选择的产物，不能重新成为自动协调真源。

一个集约根可管理多个项目仓库；每个项目有独立 archive id、授权与提交历史。环境偏好放用户选择的独立 environment 仓库并自动版本化，不复制进入项目或知识库；保存desired与应用到原生Settings分别对账，见[环境工作流](OPERATIONS.md#5-环境偏好的独立历史)。凭证继续在原生 credential/secret owner 内，禁止自动抓取环境变量、配置全集、请求正文或 credential values 归档。

### Project binding

Archive 内的项目身份由程序生成。绑定保存用户确认的 source 身份：部署拥有的 execution-world 标识、同域 canonical repository/common-dir/worktree 地址、原生 Workspace/Session 引用及可获得的基线。原生 `FsTargetKey` 不可解析，也没有可假定存在的全局 world registry；Host workspace path 不等于容器/SSH cwd。

同一仓库 worktree 可经同域 Git 证据和用户绑定归入同 project；相同 remote URL 或文件夹名不足以判同项目。新 clone、路径迁移、重建 workspace 都需显式重绑，不能扫描所有 archive 猜最近一个。非 Git source 仍可用用户绑定的 project 和 artifact digest，不虚构 commit。

绑定权威保存在 archive 的版本内；本地注册表只用于定位配置授权的 archive。丢失注册表可以重建映射，不丢协调事实；不要用原生 storage-domain 的进程内 snapshot 加一层锁冒充跨进程 CAS。实际跨进程绑定/授权入口与 Git mutation 共享锁序和版本校验，禁止 last-write-wins 覆盖。

## 2. Module 与可变职责

| Module | 小 Interface | 隐藏的 Implementation |
|---|---|---|
| Coordination | `apply(command, state, actor)` | 全部旧状态表达、引用检查、候选/检查适用性与角色规则 |
| Learning | `apply(command, state, actor)` | 教学、反思、审阅/出版、经验状态、领域归属和更正关系 |
| Archive | `read(query)`、`transact(expectedRevision, operation)` | 授权后的存储访问、原子版本、幂等收据、重放和恢复 |
| Projection | `render(state, selection)` | 由同一事实生成 checkpoint、域阅读、概览和引用；不解释事实真假 |
| DSH Adapter | 原生工具/Remote/配置注册 | 从 agent/owner 派生身份，授权和预算，连接 native selection/evidence |

纯领域 Module 与 IO 分离，但不为了测试发明可公开替换的万能 store/router。Archive 的 Depth 来自一次事务同时提供一致记录、投影和历史；所有入口跨同一 Seam，Locality 集中在提交与授权处。原生执行不属于 Archive，故不需要另一 agent loop 或任务数据库。

## 3. 模型与 UI Interface

拟议工具分成查询与两类业务命令；最终 schema 使用按 action 区分的封闭 union，不把所有字段混成可选项：

```text
ensemble_read(query)                    # invocation/checkpoint/artifact/history/reading/lessons/receipt
ensemble_work(action, payload, expected_revision, operation_id)
ensemble_learn(action, payload, expected_revision, operation_id)
ensemble_upload(action, payload)       # begin/chunk/status/commit/cancel; sealed is not yet archived
ensemble_reference(document, section?, cursor?) # packaged method references
```

`ensemble_work` 覆盖 open、amend_frame、plan_attempt、update_attempt、submit_contribution、record_finding、decide、set_candidate、record_check、record_challenge、resolve_challenge、set_next、set_lifecycle、put_artifact。put_artifact 的 change 区分 create/revise/retire/correct，后三项必须引用既有对象并注明原因，不能伪装为正文覆盖。`ensemble_learn` 覆盖 record_coaching、propose_reflection、review_reflection、publish_reflection、amend_publication、propose_lesson、assess_lesson、organize_domain；新 lesson 在 propose 分支提供全部适用/证据字段，assess 引用既有 lesson revision 及应用观察。这是目前有消费需求的命令集合；每项必须对应替代矩阵或学习正常流程，不为未来建立 CRUD 通用语言。

查询支持显式 project/invocation、文档/对象身份、revision、分页与内容选择。checkpoint、artifact、contribution和reflection draft默认按权限读取最新 committed revision，不能要求先出版才能审稿。正式reading列表和默认lesson推荐才按 publication/assessment 状态过滤，draft可显式查询。读历史时返回当时 revision、原始主张及当时知识状态，不混入“今天已知”的结论。标题/摘要列表与全文分开，查询结果可指出文档截断，不能截断后声称完整。

模型领域写操作（含新invocation的open）均需要expected archive revision；upload仅暂存内容，put_artifact接受后才提交到archive。actor、project grant、角色和 source binding 从可信调用上下文取得。仅owner初始化一个全新archive时内部使用 absent 作为期望；模型不能以open创建未授权archive。operation_id 仅为重试键，不是授权身份，可由模型/Client 生成有界 token；它的命名空间绑定 project+actor，结果持久化。先校验当前读取/操作授权，再查幂等收据，最后对新操作校验expected revision；因此丢失响应的旧revision重试能返回原收据。相同键同规范化payload返回原结果，相同键异内容拒绝；payload指动作/业务内容，不因重试的expected revision不同改变已提交动作身份，不得拿他人的键冒领结果。

返回至少包含 `operation_id`、`committed_revision`、变更对象 id、语义结果、可读文档引用，以及可区分的 failure code。持久收据保存payload摘要、操作sequence和语义结果，返回时定位该sequence首次发布的commit作为committed_revision；不能把commit自己的hash写进它的tree形成自引用。命令不返回“已启动成员”或“已完成测试”，除非实际调用路径有相应原生证据；记录声明的结果须注明 `reported`。成功保存的是声明与证据关联，不是由程序认证自然语言正确。

### 写入权限

Owner-only管理Interface提供initialize/bind/rebind/grant/revoke/takeover/assign_reviewer及[维护动作](OPERATIONS.md#2-owner-管理-interface)，Web管理Remote和认证headless入口复用它；它们通过同一授权、锁序和CAS入口维护持久授权/绑定，不暴露给普通模型命令。配置安装根只限定可管理的物理范围，不能仅凭客户端发来的 `owner:true` 授权。首次初始化在可信owner操作中生成完整初始binding/grant版本，再把identity交给模型；失败不登记半成品为可用。

- 用户在插件配置明确启用某 archive、source binding 和允许的写入范围；仅安装插件不自动授权访问所有历史。
- Invocation Lead 可修改 frame/plan/decision/candidate/next/lifecycle；在owner已委托的审阅权限内，可通过plan_attempt分配review任务并绑定非作者身份，不能创建更大的project grant。被分配成员可提交自己 attempt 的贡献、观察、稿件与证据；不能处分他人贡献或冒充 Lead。独立 reviewer 对 exact proposal revision 留 review；作者不能自写别人的 review。
- 只读跨 session 学习和恢复由 project grant 控制；知道 archive id 不等于有读取权。新 Lead 接管是 owner 操作，形成记录，不凭 `name:lead` 猜身份。
- 权限在业务执行器内检查，工具 schema 隐藏和 Client 禁用按钮不是执法。Native tool 与 Remote 进入同一执行器；撤销与提交串行化，已开始但尚未提交的写操作在 commit point 前重新核对授权。撤销完成后不再接受旧授权的新提交。
- 已明确允许的 Host app-data 写入独立于 source 文件写权限：只读 source 可以记录研究，但不得借此写 source、扩大 agent writable roots 或执行任意 Host 命令。没有有效standing grant而需要新批准时，approval never/unavailable 均拒绝；已有有效archive授权不因never自动失效，也不能由一次allowed-once升级为长期授权。明确禁止任何落盘时同样拒绝，不能偷偷落到workspace fallback。

## 4. 程序如何生成而不丢表达

结构化记录是权威，存储 event envelope（版本、actor、operation id、上个 revision、经校验的 payload、相关对象 id）及内容 blob；程序计算身份、索引和后继状态。引用模型分别表达内部对象版本、原生 Session/tool/task 指针、source artifact revision、外部资料与用户报告。外部 URL/文件可能失效，因此“已登记引用”“可读”“已核验内容”分别呈现。

程序在同一提交生成兼容现有信息结构的 checkpoint Markdown；演进文章根据已审章节渲染，研究正文通过 `put_artifact` 有界输入或原生 attachment handle 提交，未知文本作为 opaque artifact 原样保留。正文是内容，不是任意文件写操作。源代码与大文件默认仅引用，不自动复制整仓或整个会话。

内部 JSON/event 版本由插件拥有且需要持久化兼容测试，用户不手写它。生成 Markdown 也不被重新解析为命令。重建投影不得偷偷用新 renderer 改写旧 commit 的显示：历史默认读取该 commit 中保存的版本，显式 rebuild 是新版本并注明 renderer 版本。

## 5. Git 是唯一提交点

采用**插件独占的 bare Git 仓库、单主 ref 和 CAS 发布**。不采用“先写一套工作文件/SQLite，再另行 git commit”的双真源，因此没有成功写了 checkpoint 却悄悄没进历史的窗口。它仍不是远端备份；首版不自动 push、pull、merge、rewrite 或 GC 历史。

一次正常事务：

1. 验证 archive 所有权/配置、actor grant、operation 幂等键及 expected revision；读取固定 ref 对应的记录状态。
2. 纯领域校验，生成下一状态、变更记录、必要正文及 Markdown 投影；完整输入/输出预算均先检查。
3. 用专用临时 index、显式 repo 路径和固定 argv 写 blobs/tree/commit；仅涉及 plugin-owned 对象，不调用用户 source 的 `add -A`，不读其 index，不运行 source hooks/filters。
4. 在同一写入串行区重验授权，以 `update-ref <ref> <new> <expected-old>` 发布。这个原子 ref 更新是事实与投影共同生效的唯一 commit point。
5. 成功后发布 cache invalidation/通知并返回 receipt。响应丢失时，按 operation_id 查询已提交收据，不追加同一动作或重复编号。

依据是 Git 官方 [commit-tree](https://git-scm.com/docs/git-commit-tree) 与 [update-ref](https://git-scm.com/docs/git-update-ref)；工作树身份判定参考 [rev-parse](https://git-scm.com/docs/git-rev-parse)。commit 对象写出不等于 ref 更新成功；Git 自带时间元数据不进入无时间的演进正文。

全 repo revision 使不同成员并发也可能冲突；v1 返回可读 conflict 与当前 revision，让调用者重读相关对象并重新决定，不自动覆盖或把语义决定 rebase。正常单 Host 请求由实例队列排队；跨进程锁协调授权/绑定等多文件访问，Git CAS 是发布的最终防线。锁超时明确失败，PID/lease 模型只支持同一 Host/PID 语义，不支持网络共享目录多主写入。

### 成功与失败的精确范围

| 场景 | 可见结果与恢复 |
|---|---|
| 参数/授权/业务校验失败 | 无新版本，无目标文档变化；返回字段级或领域错误 |
| blob/tree/commit 准备失败 | ref 不变；未引用对象可留给受控维护，不宣称已保存 |
| expected old 不匹配 | 不发布，返回 conflict；用户/Lead 重读，不静默合并取舍 |
| Git 已发布，进程在返回前退出 | 新版本可恢复；同 operation_id 读原收据，编号不重复 |
| Git 调用结果未知 | 先查询权威 ref/receipt；不能确定则 outcome_unknown，停止依赖成功的操作，不盲目重发 |
| 原生通知/UI 更新失败 | 已提交状态保留；UI 重新 read 得到 revision；不能为了通知失败回滚事实 |
| 磁盘满/权限丢失 | 不改成 workspace 保存；保留调用方输入和明确失败，恢复存储后重试 |
| 损坏/不支持记录版本 | 只读诊断或拒绝写入，绝不 reset 成空仓库；备份/迁移由 owner 显式维护 |
| power loss | 只承诺已验证平台的 Git/fsync 能力；成功返回不是对未测试文件系统的断电持久保证 |

不为“自动历史”伪造人类作者：使用明确的插件 service identity，并在记录内保存实际 actor。自动 commit 信息只概括动作，不包含 prompt 全文、凭证或部署模型清单。

## 6. Host 与 execution world 的实际连接

当前 `ctx.fs`/`ctx.subprocess` 描述被组合的 execution world，可能在容器或 SSH；Host 管理的 archive 不能把 Session cwd 传给 Node fs 或 Host Git。需要独立 Cordis isolation group 挂公开的 local subprocess 与适用 Host sandbox，向外只暴露窄 Archive Interface；source 读/验证仍通过原 Session 执行世界。

Archive 的 Git argv、Host cwd、环境、输出上限和 teardown 均由代码拥有。限制 Git 环境覆盖（如外来 GIT_DIR/INDEX/alternates）、禁用非必要全局配置/模板/hooks、拒绝用户仓冒充 plugin bare repo；不启动 shell、不访问网络。Host archive policy 使用 Host 坐标而非 source policy；部署选定本地持久 root 后只允许这一 app-data 操作集。

原生工具显示与 sandbox 不自动提供这种授权，新增执行器必须落实第3节的权限；如果公开 composition 无法满足 Host-local Git/sandbox 同域，在接入 smoke 阶段报阻碍，不能退回裸 `child_process` 或修改 agent loop。具体源码证据与验证任务在[实施计划](IMPLEMENTATION.md)。

## 7. 迁移、导出与长期演进

旧 `.ensemble/` 的读取发生在原 execution world。一次导入由模型提出/用户授权，先生成 inventory 与差异预览，复制完整可读文件/字节、相对目录结构和内部链接信息到 archive artifact records；识别出的字段形成结构化提案，不自动变成已核验事实。遗漏、大小拒绝、二进制不支持、失效外部引用都显式列出。没有全覆盖或用户明确接受的例外，不报告迁移完成。

导入成功先保留旧文件；是否从主仓库移除既有跟踪内容是单独可审 source change，程序不改历史、不删用户目录、不把旧 commit 当当前 authored action。再次导入按输入清单/digest 判重复，变化部分形成新版本；手工编辑导出 Markdown 不自动回流。

环境仓版本化在P3交付，导入导出在P5，备份恢复、换根/换机及单主远端复制在P6。具体输入、预览、授权、校验与失败恢复见[运行管理](OPERATIONS.md#6-导入导出与恢复)。本地业务事务不访问网络；远端复制由独立授权的owner动作触发，不增加多主或自动merge。源仓checkout回退不让档案回退；历史candidate显示关联版本。卸载保留archive和原生工作成员；再启用重建cache，不重放已执行的外部操作。
