# 领域命令与查询约定

本文件规定待实现的工具字段、状态和调用结果；[档案设计](ARCHIVE-DESIGN.md)负责提交，[运行管理](OPERATIONS.md)负责用户授权与维护，[用户旅程](USER-JOURNEYS.md)给出串联样例。表中字段均必填，`?` 表示可省略；未列出的字段拒绝。数组可空仅限表中没有最低项数的字段。工具名是拟定产品 Interface，安装入口与交付进度见[实施准备](IMPLEMENTATION.md)。

## 1. 共同输入与引用

模型写入使用 `{action, payload, expected_revision, operation_id}`。project 由受信绑定确定，invocation 在 payload 中明确指定；open 不携带 invocation id。`expected_revision` 是读回的 archive commit，不接受 `latest` 或任意空值。`operation_id` 是不超过128字节的重试键，作用域为 archive+actor；同键重试保持 action/payload，改变业务内容须用新键。actor、权限、对象 id/revision、记录顺序和证据来源标记均由程序生成。

`Ref` 是以下封闭变体；可读性在访问时另查，引用自身不授予权限：

| kind | 字段 | 用途 |
|---|---|---|
| `object` | object_id, object_revision | 档案内的确切内容或判断版本；省略revision的链接只能用于导航，不能充当判断依据 |
| `source` | binding_id, source_handle, baseline, selector? | 由原execution world登记的文件集/代码引用；baseline为commit、digest或明确的unknown，handle不被当作Host路径 |
| `native_event` | session_id, event_seq | 实际记录过的原生工具/模型事件；读回另验Session权限 |
| `native_task` | root_session_id, task_id, task_revision | 原生共享任务当时的状态，不复制为另一任务板 |
| `external` | url, snapshot_ref? | HTTP(S)资料；snapshot_ref若有必须指已保存artifact版本 |
| `reported` | statement, source_label, supporting_refs | 用户/外部提供的说明；普通引用不具备owner授权效力 |

Id 是程序返回的不透明字符串，模型不得推测序号或由路径构造。对象 revision 是正整数，正文或定义修改时递增；archive revision 是一次原子提交标识。一项对象修订可以与其它对象同属一个提交。decision、review、application、assessment、challenge各有自身记录身份；它们改变目标的派生状态，不改变被评估正文的object_revision。因此别人新增资料、审阅或状态评估不会使未改动的稿件review失效。`target`、`refs`均使用上述结构；要求某类目标的动作拒绝其它kind。`content`为 `{kind: text, media_type, text}` 或 `{kind: upload, upload_id, digest}`；分块与总量规则见[预算和上传](OPERATIONS.md#4-预算上传与完整读回)。

`authority_ref`是执行器能核验的owner批准或用户指令记录。模型文本“用户同意”不满足删减范围、接管或授权要求。owner可预先给出有限范围的批准，仍检查其目标、有效期与撤销状态。

除明确列为结构体的字段外，标题、问题、理由、范围描述与限制均为非空UTF-8文本；`*_refs`是Ref数组，`*_ids`是id数组，布尔字段仅接受true/false。`coverage[]`为`{key,title,requirement,required,authority_refs,id?}`，`criteria[]`为`{key,coverage_targets,statement,critical,method,id?}`；coverage_targets为`{kind:request_key,key}`或`{kind:existing_id,id}`数组。request_key只引用同请求的coverage，existing_id须存在于修改后的覆盖集合。程序返回稳定id映射，修订时用已有id保持身份。coverage至少一项required，每项required至少关联一个criterion；新增/退役覆盖及判据通过amend_frame的requirements组原子更新，保留原记录与授权。`context_plan`为`{mode,relevance,exposure}`，`requested_selection`为`{provider,model,reasoning_effort?,preset?}`，route字段成对出现且仅作请求记录。

## 2. ensemble_work

Lead 指 invocation 当前获授权的Lead；Member 指已绑定attempt且有相应写权限的原生代理。L、M、R分别指Lead、Member、被指派的非作者reviewer，不以角色名称字符串授权。

| action | payload | 调用者与前置条件 | 结果 |
|---|---|---|---|
| `open` | title, goal, deliverable, subject, constraints, exclusions, coverage[], criteria[] | 有project.open的调用者；coverage/criteria各至少1项；criterion绑定coverage及是否关键 | 新active invocation及其Lead，生成coverage/criterion身份 |
| `amend_frame` | invocation_id, group, value, rationale, authority_ref? | L；group为goal/deliverable/subject/constraints/exclusions/requirements；requirements的value为完整`{coverage,criteria}`，其余为对应完整文本组。删除/退役或放宽用户要求需authority_ref | frame新版本；先校验修改后的覆盖与判据关系，再原子接受；旧记录与授权保留 |
| `plan_attempt` | invocation_id, question, baseline_refs, coverage_ids, difference_or_redundancy, context_plan, expected_output, early_slice, write_scope_claims, purpose, member_id?, task_ref?, requested_selection? | L；active；purpose为produce/review；context_plan含fresh/fork/continue及相关性、暴露说明；member_id必须能由原生创建事实验证 | planned attempt；可先计划后创建。review绑定另需review权限委托 |
| `update_attempt` | invocation_id, attempt_id, change | L或当前绑定M；change为下表封闭变体 | attempt新版本，保留绑定与进度来历 |
| `put_artifact` | invocation_id, change | L或授权M；change为create/revise/retire/correct，规则见下文 | 完整正文版本及digest，或退役/更正标记 |
| `submit_contribution` | invocation_id, attempt_id, summary, artifact_refs, evidence_refs, limitations, source, contribution_id? | 当前M；source为`{kind:self}`，L登记外部贡献使用`{kind:external,label,refs}`；至少一个产物或观察；新版本不覆盖旧决定 | submitted contribution，关联attempt的returned声明 |
| `record_finding` | invocation_id, kind, statement, impact, evidence_refs, coverage_ids, options?, responsible_member_id? | L/M/R；kind为issue/opportunity/gap/risk/question | finding，可作为后续取舍目标 |
| `decide` | invocation_id, target, disposition, reason, evidence_refs, consequence | L；target为contribution或finding确切版本；disposition为accepted/rejected/revise/deferred/unresolved | 追加decision；目标修订后该decision仅适用于旧版 |
| `set_candidate` | invocation_id, source_ref, description, dirty | L；active；代码、文件集或设计artifact均可，非Git资料使用digest | 新candidate；受影响checks/decisions待核 |
| `record_check` | invocation_id, check | execution允许L/M/R；applicability和resolution仅L | 观察、旧观察适用声明或冲突处分，均保留真实来源 |
| `record_challenge` | invocation_id, target, statement, contradicting_refs, impact | L/M/R；target为decision/check/publication/lesson确切版本；至少一条反证 | open challenge；当前视图标争议，涉及lesson时暂停默认推荐 |
| `resolve_challenge` | invocation_id, challenge_id, resolution, reason, evidence_refs, replacement_ref? | L；出版/lesson的语义更正另需Learning审阅；resolution为upheld/dismissed/superseded | challenge处分；upheld且影响完成条件时须reopen后继续交付 |
| `set_next` | invocation_id, action, intended_result, owner_id?, blockers[] | L；blocker含statement、影响coverage、解除依据refs；已解除项保留在history | 完整next与blocker组，action允许delivered |
| `set_lifecycle` | invocation_id, transition, reason, evidence_refs, completion? | L；按第4节转换；completion仅complete时必填 | 生命周期记录与检查点 |

`update_attempt.change`：`progress {state,reason}`允许planned/running/returned/missing；M只可报告自己当前绑定的进度。`bind {member_id,creation_ref,context_exposure,task_ref?}`及`replace {member_id,creation_ref,reason,context_exposure,task_ref?}`仅L，须在owner已委托的成员写范围内；替换收回旧成员对该attempt的新增提交权。`supersede {replacement_attempt_id,reason}`仅L，目标必须存在、不同且同invocation。旧成员已有贡献保留；迟到产物可由L作为外部贡献登记，不伪造新owner提交。

`put_artifact.change`：`create {kind,title,content,refs,domains?}`生成身份；`revise {target,title,content,refs,reason}`只允许作者或被明确移交的编辑者；`retire {target,reason}`停止默认展示；`correct {target,content,reason,evidence_refs}`追加更正正文并关联原版。kind为research/design/note/evidence/attachment/imported-original。自由内容允许Markdown、纯文本及上传的任意字节；安全预览与完整字节保存分别控制。retire/correct保留旧版。

`record_check.check`：

- `execution {target, criterion_ids, method, action, result, evidence_refs, limits}`：result为passed/failed/partial/not_run/unavailable；后两者必须解释缺口。对实际运行结果至少一条观察引用；模型提交的记录标reported。可信Adapter记录的原生事件可标observed，但不把日志成功自动翻译成业务passed。
- `applicability {prior_check, current_target, criterion_ids, scope, rationale, impact_refs}`：仅L；prior_check必须是execution，不允许嵌套applicability链。复用只覆盖显式列出的判据与范围，保留原观察结果，不能把failed/partial改成passed。
- `resolution`：仅L，字段及冲突解除条件见第4节完成谓词；它处分相互矛盾或被替代的观察，不产生新的passed执行结果。

## 3. ensemble_learn

下表所有payload均有必填`invocation_id`，表内只在直接创建工作事实的行重复列出。L/M/R按该invocation当前授权判定，目标同时必须在其project读写范围内；对来自另一invocation的lesson可新增application/assessment，但不能借此修改原作者内容。`organize_domain`操作project共享领域，除invocation Lead身份还需owner授予的project级`organize`权限；create无需既有domain即可据该上下文鉴权。

| action | payload | 调用者与结果 |
|---|---|---|
| `record_coaching` | invocation_id, attempt_id, observed_problem, diagnosis, instruction, exposure_refs, intended_transfer | L；保存干预，后续原例/新例check引用该记录 |
| `propose_reflection` | invocation_id, domain_id, title, problem, actions_and_evidence, judgment_change, limits, next_test, fact_refs, retrospective, reflection_id? | L/M；有reflection_id时仅作者可修订draft，章节组完整替换；生成draft revision |
| `review_reflection` | proposal_ref, verdict, findings, evidence_refs | 被指派的非作者R；verdict为approve/revise/reject；绑定exact revision，保留每个review |
| `publish_reflection` | proposal_ref, review_refs | L；review涵盖当前版、至少一条非作者approve且无未解决阻断；生成稳定publication id与项目内发布序号 |
| `amend_publication` | target, proposal_ref, review_refs, reason, mode | L；mode为correct/withdraw；更正或撤回说明同样走draft→review→发布，原文仍可读。等待审阅期间可立即record_challenge显示争议 |
| `propose_lesson` | invocation_id, title, trigger, action, supporting_refs, counterexamples, applicability, invalidation_condition, lesson_id? | L/M；作者修订产生新proposed版本，旧评估不迁移 |
| `assess_lesson` | lesson_ref, assessment | 下述application/decision变体；记录应用或评估，不修改环境偏好 |
| `organize_domain` | change | L；下述create/revise/move/split/retire变体；保存概览与归属，序号和旧引用保持稳定 |

审阅的findings为`{id?,statement,blocking,evidence_refs}`数组；同reviewer对同稿件revision的后续review替代其旧verdict，但历史保留。当前有效review集取每位获准reviewer的最新记录：所有阻断必须由提出者在新review中明确解除，或在新稿件review中逐项确认修复。reviewer不可用时owner可重新指派处理该阻断，替代审阅须引用原finding逐项回应；Lead不能仅另找一个approve跳过阻断。拼写/错链修正同样走更正提案，避免“轻量修改”成为语义改写入口。证据challenge会使依赖它的当前publication显示争议，直到反证处分和必要的新review完成。

`assess_lesson.assessment`：`application {invocation_id,attempt_id,context,action_taken,result,check_refs,limits}`由实际应用者提交，result为supports/contradicts/inconclusive；`decision {status,reason,application_refs,review_ref}`由L提交，status为supported/contested/retired。supported需要非作者R对该lesson exact revision的check和相关application；仅引用已出版文章或修复原例不足以证明迁移。任何持权成员可提交contradicts应用；它针对当前未退役的lesson版本时，派生状态先标contested。针对旧版或retired版本只追加反证，不改变当前版本/退役状态；显示可能影响的当前版本链接，由显式challenge或新应用处理。恢复supported必须处分反例并重新评估；retired内容须由作者提交新版本后重新走proposed。

`organize_domain.change`：`create {title,questions,audience,overview}`；`revise {domain_ref,title,questions,audience,overview}`；`move {publication_ref,from_domain,to_domain,reason}`；`split {domain_ref,new_domains[],entry_assignments,reason}`；`retire {domain_ref,successor_id,reason}`。每篇publication只有一个主domain；split要求覆盖原集合全部条目且每条恰好一个归属，交叉引用不复制主正文。overview是作者明确编写的导航说明，显示其编辑身份与revision；其中待验证的经验不得自动升级为supported lesson。

## 4. 状态与完成条件

| 对象 | 转换 | 不变量 |
|---|---|---|
| Invocation | open→active；block: active→blocked；resume: blocked→active；complete: active→completed；abandon: active/blocked→abandoned；reopen: completed/abandoned→active | resume说明解除的blocker，reopen引用新证据及原完成/放弃记录。blocked需先resume才可complete |
| Attempt | planned→running/returned/missing；running→returned/missing；missing→planned；非superseded→superseded | returned可直接来自有证据的快速任务；修订贡献不需要再造独立attempt；superseded不允许新工作提交 |
| Contribution/Finding | 创建→submitted/open；各次decision引用exact revision | disposition是L的判断记录，不覆盖内容；新内容版本默认尚未处分 |
| Reflection | draft→reviewed→published；draft修订→新的draft；review阻断→待修订 | reviewed是当前版有合格review的派生状态；published不能就地改正文，走amendment |
| Lesson | proposed→supported/contested/retired；supported→contested/retired；contested→supported/retired | 新内容版本重新proposed；retired历史可读，需要恢复时提交新版本再评估 |
| Artifact | current→新current版本/retired；correction关联原版 | 原字节和旧引用保留；retire不会删除Git对象 |

decision和execution/applicability均由程序保存当时的frame revision及candidate引用；内容不变而archive head推进不会使它们失效。frame或candidate改变后，用于完成的决定须在新上下文重新decide，可引用旧判断说明复用理由；旧execution须重新执行或由L显式applicability。完成请求的`completion`包含`candidate_ref`和每项有效coverage的`{coverage_id,decision_refs,check_refs}`。执行器要求：所有必要coverage均有当前适用的accepted结果，所有关键criterion均有当前candidate上的passed execution或合法applicability；无关键blocker和未处分的关键challenge。deferred/unresolved、partial、not_run、unavailable均不能满足关键项。删减范围先做有授权的amend_frame；状态检查通过后，由L承担完成判断。

完成判定读取该candidate/criterion的**全部适用检查**，不仅是completion请求挑选的refs。同一范围存在failed、partial、unavailable或相互矛盾的结果时，不能用旧passed覆盖；L须用`record_check.check`的`resolution {target,criterion_ids,conflicting_check_refs,conclusion,replacement_check_refs,rationale,evidence_refs}`分支明确处分。conclusion为invalid_observation/replaced/still_failing；前两者至少有一条独立依据或后续实际execution，原失败与解除链仍可读，still_failing继续阻断。新execution不得仅按时间覆盖旧失败。完成检查要求当前全部关键检查冲突已被合法resolution解除，且每项关键criterion确有有效passed。challenge处分本身不能解除执行检查冲突；关键challenge还须按其独立规则完成处分。

completed/abandoned之后允许读取、新artifact、finding/challenge、coaching、Learning动作及challenge处分；frame/attempt/候选/完成判据变更须先reopen。关闭后的新观察可记录，但不会改写原completion收据。blocked仍可收集资料、记录检查与学习，恢复后再调整交付计划。

## 5. ensemble_read 与只读 Remote

`query`包含必填`kind`、可选共同字段`project_id`及下表该kind的字段；省略project_id使用当前绑定。所有查询先验证所选project/grant，显式指定其它project只在已有读取授权内生效。Remote读同一结果，不另发明一套过滤语义。

| kind | 必填字段；可选字段 | 返回 |
|---|---|---|
| `invocation` / `checkpoint` | invocation_id；revision? | 固定提交下的frame、状态、对象引用、缺口、next |
| `object` / `artifact` | object_id；object_revision?, revision?, content_mode?, cursor? | 摘要或完整内容页；object_revision与archive revision同时存在时必须一致 |
| `list` | object_kind；invocation_id?, domain_id?, status?, revision?, cursor?, page_size? | 授权对象摘要，按稳定id排序；object_kind为各领域记录名闭集 |
| `history` | object_id或invocation_id（二选一）；revision?, cursor?, page_size? | 操作摘要、actor、对象版本和提交引用 |
| `reading` | domain_id；revision?, include_drafts?, cursor?, page_size? | 默认出版条目与更正状态；草稿须显式请求 |
| `lessons` | task_context；domain_id?, status?, revision?, text?, cursor?, page_size? | 默认supported；适用性matched/unknown/mismatch及依据，unknown单独列出，不作肯定推荐 |
| `receipt` | operation_id | 当前actor的已提交收据，或明确not_found；管理诊断可查获准actor |
| `environment_preferences` | role, task_context | 在独立environment read grant内返回候选route及可用性/授权诊断，不返回凭证 |

首次未给revision时捕获一次head，结果总带`read_revision`。cursor绑定该revision、查询摘要和排序位置；续页不得混入新head，过期返回cursor_expired，用户可重新打开。每页重新验证当前权限，历史grant不能授予今天的读权。检索先按domain/status/任务与接口能力过滤，再做Unicode规范化、大小写折叠的字面词项搜索，返回命中片段、限制条件和匹配原因；无分词语义保证，不按热度推断质量。空结果、预算拒绝和部分页分别表示。

`ensemble_reference(document, section?, cursor?)`只读取随包分发的固定参考枚举：method、glossary、patterns、checkpoint、evolution、dsh-native、dsh-commands；不接受路径或任意资源名。这些资源均来自DSH产物；method等公共内容在构建时合入，checkpoint只讲DSH工具返回的视图，其链接也只解析到DSH包内参考。支持按标题section及完整响应预算分页，返回包版本与内容digest，不需archive授权。

## 6. 结果与重试

成功写返回`{status: committed, operation_id, committed_revision, changed:[{id,object_revision}], documents, result}`；读返回`read_revision, items/content, completeness, next_cursor?`。`completeness`为complete/partial，部分结果必须给原因和续读方式；不能截断一个结构化记录后仍标complete。

| code | 含义 | 下一动作 |
|---|---|---|
| `invalid_input` / `invalid_transition` | 字段、引用种类或状态非法 | 修正业务请求，用新键 |
| `not_authorized` / `not_found` | 无授权或对象不存在；未获读权时不暴露是否存在 | 请求owner处理或核对身份 |
| `revision_conflict` / `object_changed` | archive或精确目标版本已变化 | 重读并作新决定；新业务请求用新键 |
| `operation_key_conflict` | 同actor同键不同业务内容 | 核对原请求，不覆盖原收据 |
| `budget_exceeded` / `cursor_expired` | 输入/完整输出预算或快照续页不可用 | 上传/缩小查询/重新打开快照 |
| `storage_unavailable` / `lock_busy` | 提交前失败且ref未动 | 恢复条件后可用原键重试 |
| `outcome_unknown` | 无法确认ref发布结果 | 只查receipt并对账，停止依赖该成功的动作 |
| `unsupported_version` / `archive_corrupt` | 记录或Git验证不通过 | 进入owner只读诊断与恢复流程 |

错误带`operation_id?、field?、retryable、current_revision?`，且仅向获准读者给当前revision。已提交但通知失败仍返回committed；取消在提交点之前停止，提交点附近先对账，不把取消等同于回滚。receipt在同actor仍有操作/读取权时优先于expected_revision检查；撤权后不可通过重试泄漏旧结果。
