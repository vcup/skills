# 配置、存储与运行管理

本文件是 owner 管理和数据寿命的设计约定；受测 DSH 集合与默认版本见[版本支持与升级](../UPGRADING.md)。[命令约定](COMMANDS.md)定义模型动作，[用户旅程](USER-JOURNEYS.md)定义界面和headless操作路径。owner 操作经已认证的用户控制入口进入同一 Archive 执行器；常规客户端是 Client 管理页与 `ensemble-archive` CLI。

## 1. 范围决定与支持组合

托管档案的每次写入都产生Git版本；可停用档案写入，不能启用“保存但不进历史”的模式。环境偏好使用独立environment仓库，也始终版本化。凭证由原生secret/credential owner管理，两个仓库都不复制其值。

远端能力纳入P6，定义为**单主档案的显式远端复制与恢复**：owner控制push和fetch-to-quarantine；没有后台自动同步、双向merge或多主写入。远端失败不影响已经完成的本地提交。fork保留provider/model及原effort；本轮交付范围不增加fork effort专用Interface，模型/effort差异通过fresh实现。将来若纳入同路由effort调整，须单独修改范围与执行器约定。

首个验收组合为Linux Host、Node `>=24.9.0`、受测 DSH 发行版（见[版本支持与升级](../UPGRADING.md)）、Host本地持久文件系统、Web与headless；source分别测试Host本地和一个明确映射的容器世界。macOS/Windows/SSH source作为后续平台扩展，不在首次通过结果中暗含支持。Git最低候选为2.40，P1须验证实际Git、fsync与sandbox能力；若不满足则提升最低要求或修订存储方案。网络共享目录多主写不属于支持组合。

## 2. Owner 管理 Interface

owner请求携带目标archive/environment id、`expected_revision`、`operation_id`；初始化使用absent，其余使用真实revision。管理动作统一走已认证 Remote 的 `manage` 方法（单一 `request` 参数）。旧版 `dsh-ensemble-probe` 的 `initialize`/`bind` wire 方法在 1.0 中退役，不能用来创建 v2 档案；旧档案迁移走[版本支持与升级](../UPGRADING.md)的显式流程，原库、head 与历史不被新包写入。首次选择物理位置只通过用户配置/目录选择，返回不可伪造的handle；模型业务命令不接受这些路径。GUI和headless调用同一管理Interface，headless须通过原生认证的用户控制通道执行，不能借模型工具文本冒充owner。

| 动作 | 业务输入 | 成功结果与恢复 |
|---|---|---|
| `initialize` | root_handle, source_descriptor, initial_grants, limits | 完整binding/grant初始commit，注册archive id；失败不登记可用项。**1.0 只有这一条创建路径**：`initial_grants[].subject` 为 `{kind:"owner",ownerId,hostAuthorityId}` 或 `{kind:"session",sessionId,rootSessionId}`，缺少这些字段即 `invalid_input` |
| `bind` / `rebind` | source_descriptor, mapping_evidence, reason | 新binding版本；新clone/worktree/世界映射显式核验，不按remote URL猜测 |
| `grant` / `revoke` | subject_id, rights, invocation_scope?, reason | rights限read/open/lead/member-submit/review/organize，organize明确授予project级领域编辑权；撤销与写入同序；现有历史读权也重新判定 |
| `takeover` | invocation_id, new_lead_session_id, reason | Lead变更与旧Lead写权收回同一事务，任务owner须另行原生交接 |
| `assign_reviewer` | proposal_ref, reviewer_session_id, delegated_rights | exact proposal scope的审阅授权；作者不能成为该稿独立reviewer |
| `pause` / `resume` | reason；resume附diagnostic_ref | 暂停后拒绝业务新写，读与维护可用；resume重新检查绑定、权限和存储 |
| `inventory_import` | source_handle, selection, budget | 冻结清单、digest、缺口和映射提案，返回inventory id |
| `commit_import` | inventory_id, accepted_exceptions, approval_ref | 复核源清单后原子导入；源变化则stale_inventory，重新预览 |
| `export` | revision, selection, destination_handle, overwrite_approval? | 导出manifest、内容与digest；原目标存在默认拒绝覆盖 |
| `backup` / `restore` | revision, destination_handle / backup_handle, mapping_evidence | 完整校验备份或隔离恢复候选；restore不就地覆盖正在服务的档案 |
| `relocate` | destination_handle, source_stop_evidence, mapping_evidence | 停写→复制验证→切换注册→重授权→恢复，旧位置只读保留 |
| `upgrade` | target_format, migration_plan_ref | 在隔离副本迁移并验证，切换成功后恢复服务；失败继续使用原版本 |
| `diagnose` | scope | 只读报告 binding/grants/ref/receipts/format/容量/锁，并返回 `grant_ids[]`（每项 `{grant_id, rights, scope, revoked, expires_at?}`），以便 owner 指名要 `revoke` 的授权；不输出凭证 |
| `maintain` | plan_ref, approval_ref | 执行预览过的GC/敏感数据清除等动作，记录影响与备份状态 |
| `configure_replica` | destination_handle, credential_handle, expected_remote_identity | 保存非秘密目的地和策略，secret只引用原生handle；默认无网络操作 |
| `push_replica` / `fetch_replica` | replica_id, local_revision / expected_remote_revision | 显式CAS复制或隔离获取；冲突不force、不merge、不改本地权威ref |

`source_descriptor`包含原生Workspace身份、execution-world身份、该世界里的source定位及映射证据。world身份由部署Adapter提供，无法确认Host和source隔离时拒绝绑定。`initial_grants`必须至少标明一个owner管理主体和可启动invocation的主体；owner身份依赖真实认证，不能从备份中的旧grant自行恢复。

新原生成员加入时，L可在owner委托范围内将自己的member-submit配额授权给具体attempt绑定，不能扩大project读取范围。未委托时返回需要owner授权的具体对象。reviewer同理。source只读不妨碍已获准archive记录；source的读取、导入和导出各自仍受原生权限约束。

## 3. 持久记录、身份与锁序

每个项目使用独立bare仓库，唯一业务发布ref为`refs/ensemble/main`。格式v1树布局如下；这些都是程序内部路径，不作为工具参数：

```text
meta.json                     # archive id、format、renderer、sequence、binding、grants
records/<kind>/<id>.json       # 当前对象与对象revision；无自引用commit hash
operations/<sequence>.json    # actor、action、规范化payload摘要、变更id与结果
receipts/<actor-key>/<key>.json # payload摘要、operation sequence、结果
content/<sha256>              # 接受的原始字节
views/...                    # 同次提交生成的checkpoint/reading/overview
```

Git历史保留旧对象版本；当前records是可直接读取的状态快照，operations提供顺序与动作依据。每个record携带format、kind、id、object_revision、created_sequence、updated_sequence和其类型字段。内部schema由实现提供封闭校验，未知format拒绝写；导入的未知内容放artifact而不是塞进未知schema字段。Projection可重建，content、operations及记录内容不能丢弃。

receipt保存其初次提交的sequence，不保存包含它的commit hash。查收据时沿单主first-parent历史定位该sequence首次出现的commit；可建可重建索引，索引丢失时按历史恢复。receipt与operation在档案寿命内保留；维护若清除相关历史，必须换archive id，使旧重试键不能误命中新库。相同业务重试与新业务冲突的检查顺序见[重试约定](COMMANDS.md#6-结果与重试)。

锁按**Host注册表锁→archive id排序的仓锁**获取；普通业务只取仓锁，不在持有仓锁时反向请求注册表锁。根初始化、重绑、迁移与授权变化使用同序。每个仓锁覆盖读取head、校验授权/收据、构造提交到CAS发布；普通实例队列用于减轻竞争，跨进程互斥由Host锁实现。PID不明、进程无法判死或锁损坏时不按超时强拆，返回lock_busy供owner诊断。P1验证本地OS锁和Git CAS组合。

本地注册表只保存允许定位的archive路径、预期archive id及停用状态。位置切换前先在候选仓创建完整记录并验证，注册表写入采用原子替换；跨文件中断靠relocate operation与两端identity对账，不让两个位置同时可写。授权撤销始终从当前权威ref读回；每次读取/提交在仓锁中获得授权和快照，响应发出前再次确认授权epoch，客户端丢弃旧epoch的迟到结果。

## 4. 预算、上传与完整读回

下表为P1/P6的初始验收配置，部署可显式调整。它们是有界行为的起点，容量实测后确定发布默认值；字段间不满足约束时配置加载失败。

| 配置 | 初始值 | 超限动作 |
|---|---|---|
| inline_input_bytes | 256 KiB UTF-8 | 转upload，不静默截断 |
| response_bytes | 32 KiB（含结构与元数据） | 完整记录分页；单条摘要也放不下则budget_exceeded |
| page_items | 50，最大100 | 返回next_cursor，cursor固定snapshot |
| artifact_bytes | 64 MiB | 拒绝并列为未覆盖，可由owner提高预算后重试 |
| upload_chunk_bytes | 1 MiB | 返回允许块大小 |
| upload_total_bytes / concurrent_uploads | 每archive 256 MiB / 4 | 新上传返回budget_exceeded，已完成块保留到明确取消或到期 |
| upload_idle_ttl | 24小时 | 回收未提交staging；调用者可重新开始 |
| search_scan_objects | 10,000 | 返回partial与过滤/续页建议，不声称查无结果 |
| lock_wait / operation_deadline | 5秒 / 60秒 | lock_busy；临近发布超时先查receipt |
| cursor_ttl | 15分钟 | cursor_expired，重新打开快照 |

上传入口为受限`ensemble_upload(action,payload)`：`begin {media_type,total_bytes,digest,invocation_id}`→upload_id；`chunk {upload_id,offset,bytes,digest}`→acknowledged range；`status {upload_id}`→已收区间；`commit`与`seal`是同一操作（共用`{upload_id}`载荷）→sealed内容handle；`cancel {upload_id}`→已取消。每个入口验证当前grant，chunk范围不能重叠异字节，原块同digest重试幂等；seal必须字节数和SHA-256匹配，缺块不形成artifact。sealed不等于已归档：由put_artifact消费后才随ref发布。重复使用handle不生成隐式副本；读upload也受owner/actor作用域限制。

文本按UTF-8边界分页，任意字节按base64或授权下载返回；返回总字节数、digest、offset及next_cursor。下载链接短期有效并绑定权限，不暴露Host路径。压缩包不自动解压，二进制保存不限已知格式，内联预览仅按安全支持类型开放。预算控制完整响应；大段限制条件随所属条目一起读回，不能只展示推荐而丢适用限制。

## 5. 环境偏好的独立历史

environment仓与project仓不同id/ref/权限，存储非秘密偏好：角色→候选route顺序、明确effort或inherit策略、preset偏好、适用任务条件与理由。它不保存credential values、端点密钥、完整请求或project grant。导出默认仅project，environment需单独选择，credential重新在原生owner配置。

owner动作：`environment_read`返回revision和desired/applied状态；`environment_set {preferences,expected_revision,operation_id}`保存desired revision；`environment_apply {desired_revision,target_id,expected_native_revision}`以 CAS 更新本插件在原生 Settings 注册的 rolePreferences 实例；`environment_reconcile`采集实际状态；`environment_restore {historical_revision}`以新提交恢复期望，不reset历史。写入偏好只产生desired，不能宣称已经改变原生Settings。

应用记录区分pending/applied/failed/unknown及每个设置实例的结果。target_id 指 Settings 实例，必须由部署配置给出；不在本插件注册清单内的 id 返回 `not_authorized`。Session 列表仅用于当前可用性诊断，不是隐式模型切换目标。推荐器只消费原生已读回为 applied 的值，不消费 desired；执行仍经原生显式选型与当前权限检查。这一取舍见[角色偏好决定](../adr/0002-role-preferences-do-not-grant-routes.md)。

已实现的封闭请求面（owner Remote 方法 `environment`，单一 `request` 参数）：`environment_read`、`environment_set`、`environment_restore`、`environment_grant_read`、`environment_preview`、`environment_apply`、`environment_reconcile`、`environment_backup`、`environment_recover`、`environment_history`。`environment_apply` 写的是本插件注册实例上的 `rolePreferences` 字段，以原生 Settings revision 做 CAS；冲突记 failed 且不覆盖，读回失败保持 unknown 并禁止盲重发。明确不做：切换 Lead 或 root 模型、改变既有成员模型、写入子代理 trusted `agentOptions`、扩大任何原生路由授权。

模型侧读取走 `ensemble_read` 的 `kind: environment_preferences`，需要本部署恰好装配一个活跃原生 Settings target；否则返回 `storage_unavailable` 而不是猜测目标。requested/created/actual 三阶段选型证据的接口与单元测试已完成，端到端接线仍属未验证项，不得据此声称已记录实际模型请求。并发原生设置变化时拒绝覆盖；应用响应丢失先读实际设置，不能盲重试。两套存储不构成原子事务：环境仓保存意图与对账结果，原生Settings拥有有效配置。历史恢复和重新apply都重新检查当前能力/授权。DSH新root采样路由policy，旧Session不因配置更新自动获得新权限；需要新root时明确列出这一后续动作。

模型只检索获准候选，由原生subagent执行选型。requested selection随attempt记录；created identity来自原生返回；actual request仅在授权原生日志/事件可读时由Adapter提取provider/model/effective effort、Session/event引用。原生事件缺字段或不可读就记unknown/unavailable，不从目录或模型自述填值，也不复制prompt。root选择属于用户控制，偏好推荐不能擅自切换Lead模型。

## 6. 导入、导出与恢复

**导入。** 在source execution world生成manifest：每个逻辑路径、类型、大小、digest、原始链接、读取结果及结构化映射提案。逻辑路径仅作显示/导出定位，拒绝绝对路径、`..`、越界symlink与大小写/规范化碰撞；碰撞保留两份原始artifact并给导出重命名映射。对symlink默认登记原目标文本但不跟随。清单同时覆盖无法读取、超限和未知文件，不只列成功项。

commit_import前重新核对目录成员集及每个字节digest；源发生变化则整批stale_inventory，不能把新旧快照混合提交。文件先在受限staging收齐并核验，再一次ref发布原始artifact、目录映射、映射提案和导入收据。已接受例外附owner approval并在结果标partial；仅全清单保存成功才标complete。重复inventory digest返回原导入引用；源变化形成新版本，旧源默认保留。结构化提案需L确认后走领域命令，旧日志的完成字样不直接生成当前完成判断。

**导出。** 固定revision和选择范围，先生成manifest，再写owner授权的目的地。可导出原字节、生成视图或两者，明确标original/generated；相对链接尽量按manifest映射，坏链接及外部缺失原样保留并列报告。写临时目录、全量digest验证后发布目的地；冲突不覆盖。导出的普通文件不会反向成为档案真源。

**备份与恢复。** 备份包括权威ref及其全部可达Git对象、archive identity、format/renderer说明和manifest；可用完整bundle或等价受控复制，必须在独立临时仓验证对象完整和head一致。备份加上所有所需内容才算complete，不把快照导出冒充历史备份。恢复先隔离验证。沿用原archive id激活写入，必须证明备份包含最后权威head及其全部收据；证据可来自已停写原主或可信的最终交接记录，不能仅凭备份自称最新。缺少该证明时只读恢复；owner若接受有损恢复，须新archive id、明确丢失范围/未知区间、记录来源旧id，并重新建立授权与重试命名空间，禁止跨id自动重放旧operation。随后由当前owner确认source映射并重发grant；旧grant仅作历史，不自动生效。失败保留原库和诊断；源代码、原生Session日志及凭证不是project备份的一部分，manifest明确外部依赖。

**换根/换机。** 停写并取得单主所有权交接证据；建立并验证备份；新Host按支持组合恢复，重新绑定/授权；旧writer保持禁用后切换注册。无法确认旧主停写时只允许只读副本。相同archive id的两份可写副本不能并行注册。

**升级。** format和renderer版本分开。读取历史优先使用该commit已保存视图；新的renderer重建是新提交。format升级在备份和隔离副本上执行，验证原字节、对象关系、receipt及投影后切换。未知未来format拒写；失败不reset或降级覆盖。允许代码回退的范围由迁移说明明确，不能假定数据可逆。

## 7. 远端复制、维护与敏感材料

远端仅作为单主的复制目标。owner 显式选择目的地和原生 credential handle；project 正文只记录 replica id、期望/观察到的 revision 与结果，不含 URL 凭证。push 使用 remote 旧 ref 预期与 fast-forward 检查，拒绝冲突和不相关历史；fetch 进入隔离候选仓，仅验证和报告差异。恢复到本地权威位置复用 restore/relocate 授权，不自动 pull 到活动 ref。断连返回 failed 或 unknown，重新读取远端 ref 后对账，不能把网络请求已发出当备份完成。网络权限独立于本地 archive grant。

**当前实际可用范围。** 复制**引擎**与两个**真实 transport**都已实现并对真实 `git://` 远端验证过，但**出厂 composition 不挂载任何网络 transport**。因此：

- 默认安装只支持 **Host 本地 `file` 目的地**的复制；
- 指向非 Host 世界的目的地时，未挂载 transport 的执行器返回 `not_authorized`，说明需要另行批准的原生网络能力；
- **不得声称 1.0 默认可用 ssh/https 远端复制**；`ssh://` 也不是本版的受支持复制协议（仅 `https`/`http`/`git`）。

**两个 transport 的协议集不同，不能混写。**

| transport | 位置 | 协议 | 用途 |
|---|---|---|---|
| 部署 transport | `adapters/dsh/maintenance/network-deployment.ts`（`createAllowlistedReplicaTransport`） | 仅 `https`/`http`/`git`，且 `host[:port]` 必须在部署 allowlist 内 | 供部署显式装配；拒绝 URL 内嵌 userinfo、未声明主机或端口、`file://`、`ext::`，拒绝空 allowlist |
| 验用 transport | `adapters/dsh/maintenance/network.ts` | 仅 loopback 的 `git://`/`http://`/`https://` | 只用于对真实 `git daemon` 的验收，**不是生产 transport** |

两者共同约束：固定 argv（不经 shell、不接受调用者 argv）、剥离环境（`GIT_CONFIG_GLOBAL=/dev/null`、`GIT_TERMINAL_PROMPT=0`、空 `GIT_ASKPASS`）、只做 expected-remote CAS 与 fast-forward（never force、never merge）、fetch 进入私有隔离候选且绝不移动主 ref、push 后重新读取远端。

**部署声明。** 目的地由部署声明，不由调用者提供。原生适配层读取 `DSH_ENSEMBLE_REPLICA_DESTINATIONS`：一个以 handle 为键的 JSON 对象，可带一个可选顶层 `allow`（`host[:port]` 数组）；每个目的地的字段**只有** `url`、`identity`、`credential_ref`、`credential_username`，任何其它字段（包括旧式的 `credential_env` 与任何 `GIT_*` 名）都是未知字段，启动时拒绝。该变量只在部署装配了 transport 时才有意义；未设置时不挂载任何网络 transport。

`credential_ref` 与 `credential_username` 必须成对：前者是 Host credential provider 中的秘密引用，后者是**非秘密**的 HTTP Basic 用户名（不含 `:`、控制字符或首尾空格）。只有其一即被拒绝：`credential_ref` 缺用户名时给出“HTTP Basic authentication needs a user name as well as the secret”，只有用户名时给出“a user name alone cannot authenticate”。

凭据在每次传输时解析，值只经由包内**固定的私有 askpass helper** 交给 Git：helper 分别回答 Username 与 Password 提示、拒绝未知提示，配合 `GIT_TERMINAL_PROMPT=0`、禁 ambient credential helper、禁用重定向与 `LC_ALL=C`。部署不能指定环境变量名或 helper 路径，值不进入 URL、argv、结果或档案。`configure_replica` 只保存非秘密目的地与策略，网络动作另需独立授权。

**证据边界。** 引擎与 transport 由仓库门验证：`bun test adapters/dsh/maintenance/network-deployment.test.ts` 与双版本 `scripts/verify-dsh-maintenance.ts`（真实 Cordis、真实 subprocess/sandbox provider、真实 Git、真实 OS 锁）覆盖 push/fetch、CAS 冲突与隔离候选。这证明网络 pipeline 与凭据机制成立，**不**证明任意远端主机、TLS 或跨网络拓扑；跨 Host 复制需要真实 allowlist 端点，其验收不在本版证据内。

一个容易混淆的区分：匿名 `git://` 端点**不能**证明凭据认证成立。实测中，普通注入的环境变量对 Basic-auth 远端失败的形态与“完全没有凭据”相同，而上述 helper 才成功。所以“复制在匿名 git 上可用”与“复制会做凭据认证”是两个不同主张，只有后者与凭据有关。

容量诊断报告可达内容、历史、未引用对象、staging及缓存占用；GC只在停写、备份校验后按owner预览计划执行，保留可达业务历史与receipts。没有自动保留期删除。逻辑正文限额和实际磁盘剩余分别检查，磁盘满不写source fallback。

敏感内容误入：先暂停相关读/写与导出、撤销分享handle，再列影响commit/artifact及已知备份/副本。owner选择保留私有历史并撤回推荐，或执行破坏性清除。清除须明确批准、隔离重建、生成新archive id、重新授权和逐副本处置；正常append-only约定不覆盖这项特殊维护。结果列出已处理和不可确认的副本，不承诺删除外部已取得的内容。普通模型命令不具备清除能力。

卸载撤销注册、取消在途准备阶段并对账已提交操作，释放锁与资源；保留档案、已接受内容和原生工作成员。再启用从权威ref恢复状态，清理过期staging，不重放历史工具或外部动作。
