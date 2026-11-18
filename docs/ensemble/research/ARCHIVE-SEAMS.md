# 新版 DSH：独立 Archive 与环境配置的公共接入点

> **历史接口研究：开发快照，不是发行契约。** 原研究日期为 2026-11-17，固定源码为 `39163dd30f703a79079e2d2446545cff3c453738`；这是 rc.3 同步开发快照，不是正式 rc.3 或 rc.4 发布提交。现行基线是正式 rc.4 `3f321d32bfe382212a8ed8785c1d47a5a300aa23`，见[发布基线](<RC4-BASELINE.md>)与[插件接口复核](<RC4-PLUGIN-SEAMS.md>)。实施以[档案设计](<../ARCHIVE-DESIGN.md>)、[运行管理](<../OPERATIONS.md>)及[实施准备](<../IMPLEMENTATION.md>)为准。

原研究只读核查固定源码，未安装、实现、创建实验代理或运行产品验收。以下“原生事实”来自该提交；“建议”保留当时插件设计推导，不声称 DSH 已实现 archive 领域规则。特别是第 6 节提出的本机 volatile 偏好存储已由现行独立 environment 仓库方案取代；原生 Settings/凭证机制与 ensemble 偏好的存储所有者须分别理解。

## 1. 结论与范围

**可以复用原生公开的本地 subprocess、sandbox、Cordis isolation、Settings、Credentials 和 Typert Remote；需要新增的是窄 Archive Module，不是执行路由器，也不是任意路径文件工具。** 插件模式下 archive 完全位于工作区外；模型只提交 contribution/decision/verification/teaching 等领域命令，程序校验、保存私有 typed records 并生成普通 Markdown。模型不维护工作区状态文件。工具需覆盖现有 `.ensemble` 的全部表达能力；artifact 正文仍可作为受界定的领域内容提交，限制的是任意落盘路径、目录/版本管理和绕过领域校验，不是禁止保留研究/设计正文。

采纳 Lead 的单项目 bare Git archive、单 ref 方案：records 与渲染文档同 tree，ref 的 expected-old 发布是唯一可见提交点。`ctx.storage.domain` 不承担协调正文的第二权威，不先写 worktree/SQLite 再提交 Git。authoritative bindings 也在同 Git 事务中维护，DSH storage 只作可重建 discovery/cache。具体 Git 对象、ref、命令去重与历史模型由 Lead 设计；本研究限定在 DSH 接入、权限、生命周期与故障语义。

两个执行域必须明确：**源代码访问走源 Session 的 execution-world 能力；archive 持久化走明确配置的 Harness Host 本地能力。** 此处 Host 指运行 Harness 进程的文件域；Harness 自身若运行于容器，local provider 就是该进程所在容器，绝不获得物理宿主路径。字符串相同不证明两个域相同。

## 2. 原生事实与可实现接入

| 需要 | 公开 Seam / 原生事实 | 插件的使用方式与限制 |
|---|---|---|
| 源文件定位/读取 | `FileSystem.resolve/processPath/contains/lstat/readBytes`；`FsTargetKey` 不可解析。[FS][fs] [identity][fs-id] | 只让同 execution world 的 subprocess 消费 `processPath`；不将 target key、Session cwd 或 container path 交给 Host Node fs。读取有界源证据，不能以读取授权推导写入授权。 |
| Host 路径显式映射 | `processPathFromHostPath` 默认返回 undefined；provider 只有确认同一文件时才映射。[FS][fs] | 这是 Host→execution-world 可选映射，不是任意逆映射；archive 不依赖它向模型暴露真实路径。 |
| 本地 Git 进程 | 公开 `@deepseek-ai/dsh-subprocess-local` 导出 `LocalSubprocessRuntime`；普通 `ctx.subprocess` 是可替换 execution-world 能力。[local][local-process] [exports][local-exports] | 用独立本地实例执行 archive Git，不假定当前全局 provider 是 Host。命令 argv 由程序构造、正文走 stdin，不接受模型 shell/argv/config。 |
| 并列能力组合 | Cordis `ctx.isolate(name)` / Loader group `isolate` 产生独立 service scope，不回退父同名能力。[isolation][isolation] [组合][isolation-guide] | archive 存储 group 隔离 `subprocess`、`sandbox`，显式挂 local providers；需要 Host FS 时也隔离 `fs`。仅将窄 `ensembleArchive` Interface 提供给外层 tools/Remote，源代码适配留在原域。真实 Loader 验收此连接。 |
| Host Git 写限制 | `SubprocessSpawnSpec` 无 sandbox policy；`spawn` 不是批准或 confinement。`SandboxProvider.confine` 接受完整同域策略，失败不自动放宽。[spawn][spawn] [sandbox][sandbox] | Archive 授权通过后，以本地 canonical archive 根构造专用 `workspace-write` 策略，再 `confine`→本地 `spawn`；不是套用含远程 cwd 的原 Session policy，也不是为成功而使用 danger-full-access。 |
| 有界进程生命周期 | subprocess 提供 bounded stdout/stderr、`done`、`terminate`、`waitForExit`；deadline 归调用者，dispose 会终止并等待本地进程范围。[local][local-process] [handle][process-handle] | 每个归档命令绑定调用/插件生命周期；stderr 有界，lossy 的结构化 stdout 拒绝解析；超时不能直接推断 ref 没变。 |
| 本机小记录 | `defineDomain/domainTable`→`ctx.storage.domain.open(spec)`，记录 schema 在 durable read 校验；domain 单写链和同步 `update` transform；close 拒绝新写并 drain。[domain][domain] [update][domain-update] | 只放可重建的 binding discovery/cache 等小记录；authoritative bindings 与协调记录同 Git 事务。无跨记录/Git事务，不能从 domain queue 推导跨进程 CAS；限制见第 5 节。 |
| 配置与凭证 | Settings 只给 `.volatile()` 字段生成 live form；`mutate/update` 可带 expectedRevision。Credentials 保存引用/值并按次解析。[settings][settings] [form][settings-form] [credentials][credentials] | 安装根/Git executable 是可信部署配置；常用非秘密偏好可 volatile。route/provider/effort 直接复用原生设置/工具，不复制授权表；secret 不进 archive。 |
| Archive Remote | `TypertRemoteService` / `@Remote` / `TypertResourceMap`，Gateway 在 lookup 前检查 non-owner 的 action+resources；owner 放行。[remote][remote] [gateway][gateway] | 新 `ensembleArchive` namespace 按 ProjectId/RunId/revision 读列表、历史与正文；没有 `read(path)`。写入与模型命令调用同一领域入口。RPC 身份检查不替代领域绑定/写授权。 |

原生 `workspaceFiles` 是 composed FS 上的只读文件 Remote，路径解析与观察仍依赖源 execution world；不能用它读取另一个 Host 域的 archive，更不能用它完成领域写命令。新 Archive Remote 以 opaque archive identity 读取已提交视图，不把 Host path 转发给 filesystem。[workspaceFiles][workspace-files]

已有 Git 消费者可参考但不可当成公共 Git 库：`workspace-changes` 的 GitRunner 是内部快照实现；实验 `worktree` / `client-ui-forge` 的同域 `sandboxPolicy.resolve`→`sandbox.confine`→`subprocess.spawn` 路径展示正确进程顺序，但不是 archive 授权或通用 Git 事务 Interface。[快照][git-snapshot] [worktree][git-worktree] 不导入它们的 `src/*`，不因为存在实验代码而新增依赖。

## 3. 权限必须在 Archive mutation 入口成立

**原生没有“任意插件在 Host 外置目录写 archive 已获用户许可”的现成结论。** `storage-json` 使用 Node fs 的受信配置根，`LocalFileSystem` 本身不围限；二者都不经过模型工具的 fs escalation。`fs-observation-policy` 只是由工具显式触发的先读/版本检查，并不是 Host 所有写入的自动护栏。[JSON][storage-json] [local-fs][local-fs] [fs-policy][fs-policy]

建议采用独立、明确的 archive 应用数据授权：owner 在设置/安装流程确定 Host archive 根、项目绑定及允许的领域操作；模型只能使用被绑定的 ProjectId/RunId。启用授权说明必须写清“自动向工作区外的指定 archive 保存协调记录及本地 Git 历史”，不能把选择路径或查看页面当成此授权。每次 mutation 在排队后的实际执行点重验绑定、写入许可和撤销状态；同进程工具调用也必须检查。未知项目、agentless tool call、来源不匹配或已撤销都拒绝。

源文件权限与 archive 应用数据权限分开：原研究要求产品明确决定源 `read-only` 下是否允许已授权的协调记录写入，类似原生 Session/Team 应用数据可持久化的区别；不能默默将其解释成所有 Host 写入许可。现行[写入权限](<../ARCHIVE-DESIGN.md#写入权限>)已明确：有效 standing grant 下的 Host app-data 写入可独立于只读 source。若用户明确禁止任何落盘，则 archive mutation 也拒绝。创建源 worktree、修改源码、导出到工作区仍回到源 Session 的原生权限路径。

公开 `ctx.approval.request({agent,toolName,callId,reason,signal})` 可承载确需单次确认的动作；返回只有 `allowed-once/rejected/cancelled/unavailable`，`never` 确定拒绝，无 answerer fail closed。它不创建跨会话持久授权，不能把一次批准缓存成永久许可；owner 的持久 archive opt-in 由插件配置/绑定明确拥有。[approval][approval] `credentials/authorization` 是获取凭证的人机流程，不是文件权限授权。

不要为了 archive 自动调用 `registerWritableRoot` 扩大源 Session 可写范围。该公开方法会让未来同 Session workspace-write 操作一起获得额外目录，runtime-only、resume/fork 不自动恢复，Windows process confinement 还不支持额外目录；它既不进行用户批准，也不是 archive 私有权限。[roots][roots]

Host archive 根只来自可信部署配置，命令不接受 Host path。规范化、拒绝工作区/源码仓库及其下属路径、拒绝 symlink/不可信已有目录、使用插件创建的 bare 仓库和受限生成名称；改变根是重新配置/绑定操作，不能把 `.volatile()` 根变化当成自动迁移。Git policy 写根只包含 archive 所需区域，禁用 hooks/外部 filters/任意 Git config 注入，环境去除 Git selector 与隐式凭据；具体 Git 列表由 Lead 事务设计负责。Sandbox 的 file-effect 限制不控制网络，因而本地 archive runner 本身也不提供 fetch/push/任意子命令。

Remote 必须声明所触及的全部 archive resource；授权一个 Session 不自动授权同项目全部历史。列表/stream 对每条结果过滤，重连先基线，撤销后不得继续泄漏。`remoteAccess.allows` 在 Remote 外默认 true，因此它不是模型工具的共享写权限检查；共同 Archive mutation 入口需显式拿到可信 caller 及绑定。[resources][remote-resources] [allows][remote-allows]

## 4. Project、源仓库和 worktree 绑定

原生 `WorkspaceRegistry.path` 用 **Host `fs.realpath`** 规范化，不是通用远程仓库 identity。FS `targetKey` 只在 provider 语境稳定且不承诺跨 provider 唯一；公开 FS Interface 没有通用 execution-world registry。不能用同名目录、同 remote URL 或相同 cwd 字符串自动合并项目。[workspace][workspace-path] [identity][fs-id]

建议 ProjectId 由 archive 领域拥有；本机 binding 明确记录 execution environment 身份、同域验证的 repo/common-dir/worktree 定位及 native Workspace/Session 指针。源码 Git 探测通过源域 `fs`+`subprocess`+原 Session policy，archive Git 从不在源目录运行。关联 worktree 必须同域验证属于该 repository；一个项目可拥有多个显式 source bindings。环境标识来自部署绑定，不虚构成 `FsTarget` 原生字段。binding 是本机操作定位/许可，归档中可保留经过筛选的候选 commit、证据或 binding id，但不能依赖本机绝对路径作为可移植真相。

源环境不可达时可继续显示已提交 archive 历史；重新核对源码/运行检查明确显示不可用，不冒充已验证。原生成员身份/实际请求仍从 native Session 查证；archive 只记录指针和有依据的协调声明，不维护第二 roster 或恢复原生成员的数据库。

## 5. Git commit 点、bindings 并发和恢复

### 协调内容只在 Git 中发布

正常路径为：可信 caller→解析有界领域命令及 expected revision/operation id→重验绑定与权限→读指定 ref 的 schema→执行纯领域变换→同 tree 生成 records 和 Markdown→Git expected-old 发布→返回新 commit/revision→发布 UI 通知。语义检查不能只在工具 schema；Remote 和直接调用也经过同入口。不要自动把 CAS loser 的 decision/verification 命令合并重放到新 head，先返回 conflict 供调用者重读。

对象写入成功但 ref 未发布时，旧视图完整；成功后通知失败不能撤回提交或谎报“未保存”。取消/超时靠近 ref 更新时结果可能不明，应按 operation id/目标 ref 对账，再报告 committed、conflict 或 outcome-unknown；不能盲目重试制造重复事件。Git 成功不等于模型已收到结果，Session 工具日志与 archive 也没有分布式原子性。operation id 与规范化请求摘要必须在同一已提交内容里形成恢复依据。

插件 HMR/dispose 先关 admission，再 abort/drain 活动 runner；新实例从 ref 和私有 schema 重载，未提交内存不作为真相。未知未来 schema 拒绝写入，迁移由 archive owner 版本化、以新 commit 追加；不修改原生 Session 格式。Markdown renderer 的版本和 record schema 应可辨，旧提交可按其已保存文档读取，不把旧记录按新 renderer 静默改写。

Git ref atomicity 不自动等于任意 OS/文件系统掉电耐久；具体 fsync、Git 最低版本、bare repo 设置与故障注入属于 Lead 的 Git 验收。原生 `writeFileAtomic` 自己明确排除 fsync，不能借其名字声称补足这点。[atomic][atomic]

### bindings 不能误用 domain 的内存锁

`storage-json` 明确不支持跨进程写锁，whole-unit 写采用 last-completion-wins；domain 的读取是本实例权威内存。给 `domain.table.update()` 外包一个 file lock，**仍可能读取旧 snapshot 并覆盖其他进程的 bindings**。[JSON 限制][storage-limit] [domain][domain-update]

已选定 authoritative bindings 在 Git 同事务维护，DSH storage 至多提供 cache/discovery。cache 丢失、落后或未写成功不影响已提交绑定；重新读取 archive ref 验证后可重建，不能凭 cache 给模型写授权。初始化/发现过程必须核对 Git 中的项目与绑定身份，不能因索引缺失自动创建第二项目。这样没有 bindings 文档与 Git 正文的双提交点。

公开 `@deepseek-ai/dsh-atomic-write` 的 `withFileLock` 可用于确有需要的 Host 辅助独占，提供同 Host/PID namespace 跨进程等待、超时和已死 PID 接管；不支持多 Host 或不同 PID namespace 共享文件。锁持有者启动的子进程必须一同停止，才能安全接管。[lock][lock] 它不是本方案的 archive commit 点，也不替代 Git ref CAS。

## 6. 环境偏好、凭证和高频日志分离

**历史建议与现行决定的区别：** 下表保留当时把 ensemble 偏好放在本机 Config/volatile 字段的建议，便于理解 Settings 接入推导。现行[环境工作流](<../OPERATIONS.md#5-环境偏好的独立历史>)改为在工作区外的独立 environment 仓库保存非秘密 desired 配置，并将“保存偏好”与“应用到原生 Settings”分别对账；原生 route 授权与凭证 owner 不变。不要照下表再建立一套偏好真源。

| 数据 | Owner / 位置 | 不应做的事 |
|---|---|---|
| provider、endpoint、credential reference、原生 allowed route policy | 当前 DSH profile 中原生 provider / selection Settings；凭证值由 Credentials provider 保存 | 不把配置副本、key、OAuth token 或整份请求 header 自动提交进 archive |
| ensemble 环境偏好，如某用途优先使用某获准 route/effort | 插件本机 Config 的 volatile 偏好或小型非秘密环境记录；仅作选择建议 | 不是授权，不能把偏好填入可信 `agentOptions` 绕过原生 policy，也不热换既有成员模型 |
| 实际选型的证据 | native child `request/header` 中经核对的安全字段/指针，选择性形成领域证据 | 不把可用模型列表或请求参数当实际调用成功 |
| 贡献、取舍、教学依据与综合结论 | archive 私有记录及同 tree 生成文档；记录声明者和证据类型 | 不把一条模型教学建议自动升级成已验证规则或全局环境配置 |
| token/工具逐条事件、原始输出、运行日志 | 原生 Session/本机日志或有界外部产物 | 不监听每个 event 自动 Git commit，不把高频日志混入可审阅协调历史 |

Settings 当前只暴露 schema 的 `.volatile()` 字段并以 entry id 命名；`mutate` 是按字段安全编辑，避免用 redacted form 重建完整 config 丢失 secret。expectedRevision 在 config-editor 的受锁重读/reconcile 回调内检查；它属于设置的 CAS，不是 Archive revision。[settings][settings] [config-editor][config-editor] Archive 根等需重启/重绑的字段保留普通 Config，不设计成随时切换的 live 偏好。

Credentials 的 `resolve/describe` 区分实际值与安全状态；原生 API-key provider 的 `apiKeyEnv` 是 `role('credential-ref').volatile()`，按请求解析。环境隔离不等于每个 DSH profile 自动拥有不同 key：默认 local provider 共享 `$DSH_HOME/.credentials.yaml`，必要时用不同引用、明确 profile/DSH_HOME 配置完成隔离，不能承诺凭空得到 per-project secret store。[credentials][credentials] [credential-local][credential-local] [provider-config][provider-config]

## 7. 实施验收重点（本轮未执行）

1. **真实组合**：Loader 将源 fs/subprocess 替换为远程/容器 provider，archive 仍只使用显式 local 实例；相同字符串路径分别指向不同内容，不能错域读写。unload/HMR 证明工具、Remote、监听与 runner 被撤销/drain，重新加载从 Git ref 恢复。
2. **权限**：未启用、未知 binding、其他 Session/项目、已撤销、agentless、Remote non-owner 都拒绝；拒绝无 ref 变化。owner opt-in 与 source read-only 的既定产品规则明确测试；archive 不能修改源文件或利用 symlink/argv/Git config 触及别处。sandbox 不可用时无 unconfined fallback。
3. **CAS 与结果不明**：两进程同 expected ref 只有一个发布；失败前旧文档与records一致；提交后断连接收重试可对账去重；超时在发布前后分别测试，不凭退出状态猜测未提交。
4. **持久与版本**：records 和 Markdown 同 commit；schema future/version mismatch fail closed；重启/迁移不丢已提交历史；bindings 同事务发布，cache 缺失/过期时重建且不能误授权；不能以 JS queue 测试代替跨进程验收。
5. **环境与泄漏**：偏好不扩大原生模型授权；credentials/route配置与高频日志不被自动归档；原始工具结果不得含 key；有界输出与错误不泄漏完整环境。真实模型选择沿已有验收，不在此重建全栈。
6. **视图与导出**：Archive Remote 返回某个明确 revision 的记录/渲染文档，内容跨重连一致；不能通过 path 参数读任意 Host 文件。导出到源工作区是单独明确的文件写操作，不是 archive read 的附带效果。

## 固定来源

[workspace-files]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/api/workspace-files/src/index.ts#L1-L20
[fs]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/fs/fs/src/index.ts#L140-L190
[fs-id]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/fs/fs/src/types.ts#L11-L68
[local-process]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subprocess/subprocess-local/src/index.ts#L70-L160
[local-exports]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subprocess/subprocess-local/package.json#L14-L31
[isolation]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/vendor/cordis/src/context.ts#L111-L130
[isolation-guide]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/docs/user/develop/framework/service.md#L111-L139
[spawn]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subprocess/subprocess/src/types.ts#L71-L107
[process-handle]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/subprocess/subprocess/src/types.ts#L161-L196
[sandbox]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/sandbox/sandbox/src/index.ts#L32-L89
[domain]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/storage/storage-domain/src/index.ts#L64-L152
[domain-update]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/storage/storage-domain/src/domain.ts#L1-L136
[settings]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/settings/settings/src/index.ts#L298-L424
[settings-form]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/settings/settings/src/schema.ts#L33-L47
[credentials]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/credentials/credentials/src/index.ts#L154-L250
[remote]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/api/remote-access/src/index.ts#L145-L222
[gateway]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/api/gateway/src/index.ts#L760-L828
[remote-resources]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/typert/protocol/src/index.ts#L144-L181
[remote-allows]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/api/remote-access/src/index.ts#L224-L244
[git-snapshot]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/deliverables/workspace-changes/src/git.ts#L40-L80
[git-worktree]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/experimental/worktree/src/process.ts#L30-L70
[storage-json]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/storage/storage-json/src/index.ts#L22-L79
[storage-limit]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/storage/storage-json/README.md#L135-L145
[local-fs]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/fs/fs-local/src/index.ts#L69-L75
[fs-policy]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/fs/fs-observation-policy/src/index.ts#L1-L15
[approval]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/interaction/user-approval/src/index.ts#L125-L150
[roots]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/sandbox/sandbox-policy/src/index.ts#L196-L260
[workspace-path]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/workspace/workspace/src/paths.ts#L39-L56
[atomic]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/util/atomic-write/src/index.ts#L65-L96
[lock]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/util/atomic-write/src/index.ts#L233-L262
[config-editor]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/boot/config-editor/src/index.ts#L81-L151
[credential-local]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/credentials/credentials-local/src/index.ts#L1-L35
[provider-config]: https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/llm/llm-deepseek-api-key/src/config.ts#L17-L59
